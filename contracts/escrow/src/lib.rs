use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

const MAX_PROVIDER_SIG_LEN: usize = 128;

declare_id!("6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL");

#[program]
pub mod escrow {
    use super::*;

    pub fn init_payment(
        ctx: Context<InitPayment>,
        call_id: String,
        service_id: String,
        amount: u64,
        sla_ms: u64,
        dispute_window_s: u64,
        total_units: u64,
    ) -> Result<()> {
        let ec = &mut ctx.accounts.escrow_call;
        ec.call_id = call_id;
        ec.payer = ctx.accounts.payer.key();
        ec.service_id = service_id;
        ec.provider = ctx.accounts.provider.key();
        ec.amount = amount;
        ec.start_ts = Clock::get()?.unix_timestamp as u64;
        ec.sla_ms = sla_ms;
        ec.dispute_window_s = dispute_window_s;
        ec.total_units = total_units.max(1);
        ec.units_released = 0;
        ec.provider_sig = Vec::new();
        ec.status = Status::Init as u8;
        transfer_into_escrow(
            &ctx.accounts.payer,
            &ctx.accounts.escrow_call,
            &ctx.accounts.system_program,
            amount,
        )?;
        Ok(())
    }

    pub fn fulfill(
        ctx: Context<Fulfill>,
        response_hash: [u8; 32],
        ts: u64,
        provider_sig: Vec<u8>,
    ) -> Result<()> {
        let ec = &mut ctx.accounts.escrow_call;
        require!(ec.status == Status::Init as u8, AssuredError::InvalidStatus);
        require_keys_eq!(
            ctx.accounts.provider.key(),
            ec.provider,
            AssuredError::InvalidProvider
        );
        require!(
            provider_sig.len() <= MAX_PROVIDER_SIG_LEN,
            AssuredError::SignatureTooLong
        );
        ec.response_hash = response_hash;
        ec.delivered_ts = Some(ts);
        ec.status = Status::Fulfilled as u8;
        ec.units_released = ec.total_units;
        ec.provider_sig = provider_sig.clone();
        emit!(Fulfilled {
            call_id: ec.call_id.clone(),
            ts
        });
        emit!(TraceSaved {
            call_id: ec.call_id.clone(),
            response_hash,
            provider_sig,
        });
        Ok(())
    }

    pub fn fulfill_partial(
        ctx: Context<Fulfill>,
        chunk_hash: [u8; 32],
        units: u64,
        ts: u64,
        provider_sig: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.provider.key(),
            ctx.accounts.escrow_call.provider,
            AssuredError::InvalidProvider
        );
        require!(
            provider_sig.len() <= MAX_PROVIDER_SIG_LEN,
            AssuredError::SignatureTooLong
        );

        let result = apply_partial_release(
            &mut ctx.accounts.escrow_call,
            chunk_hash,
            units,
            ts,
            &provider_sig,
        )?;

        if result.payout > 0 {
            let escrow_info = ctx.accounts.escrow_call.to_account_info();
            let provider_info = ctx.accounts.provider.to_account_info();
            pay_out(result.payout, &escrow_info, &provider_info)?;
        }

        let ec = &ctx.accounts.escrow_call;
        emit!(PartialReleased {
            call_id: ec.call_id.clone(),
            units: result.units,
            total_units: result.total_units,
        });
        if result.emit_trace {
            emit!(TraceSaved {
                call_id: ec.call_id.clone(),
                response_hash: chunk_hash,
                provider_sig,
            });
        }
        Ok(())
    }

    pub fn raise_dispute(
        ctx: Context<RaiseDispute>,
        kind: u8, // enum: 0 LATE, 1 NO_RESPONSE, 2 BAD_PROOF, 3 MISMATCH_HASH
        reason_hash: [u8; 32],
        _reporter_sig: Vec<u8>,
    ) -> Result<()> {
        let ec = &mut ctx.accounts.escrow_call;
        // TODO: verify reporter_sig over (call_id, kind, reason_hash)
        require_keys_eq!(
            ctx.accounts.reporter.key(),
            ec.payer,
            AssuredError::InvalidReporter
        );
        require!(
            ec.status == Status::Init as u8 || ec.status == Status::Fulfilled as u8,
            AssuredError::InvalidStatus
        );
        ec.disputed = true;
        emit!(Disputed {
            call_id: ec.call_id.clone(),
            kind,
            reason_hash
        });
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        require!(
            ctx.accounts.escrow_call.status == Status::Fulfilled as u8
                || ctx.accounts.escrow_call.status == Status::Init as u8,
            AssuredError::InvalidStatus
        );
        require_keys_eq!(
            ctx.accounts.payer.key(),
            ctx.accounts.escrow_call.payer,
            AssuredError::InvalidPayer
        );
        require_keys_eq!(
            ctx.accounts.provider.key(),
            ctx.accounts.escrow_call.provider,
            AssuredError::InvalidProvider
        );
        let now = Clock::get()?.unix_timestamp as u64;
        let outcome = evaluate_settlement(&ctx.accounts.escrow_call, now);
        let amount = ctx.accounts.escrow_call.amount;
        let released_so_far = amount_for_units(
            &ctx.accounts.escrow_call,
            0,
            ctx.accounts.escrow_call.units_released,
        );
        let remaining_units = ctx
            .accounts
            .escrow_call
            .total_units
            .saturating_sub(ctx.accounts.escrow_call.units_released);
        let remaining_amount = amount.saturating_sub(released_so_far);
        match outcome {
            SettlementOutcome::Release => {
                if remaining_units > 0 {
                    let payout = amount_for_units(
                        &ctx.accounts.escrow_call,
                        ctx.accounts.escrow_call.units_released,
                        remaining_units,
                    );
                    if payout > 0 {
                        let escrow_info = ctx.accounts.escrow_call.to_account_info();
                        let provider_info = ctx.accounts.provider.to_account_info();
                        pay_out(payout, &escrow_info, &provider_info)?;
                    }
                }
                let ec = &mut ctx.accounts.escrow_call;
                ec.units_released = ec.total_units;
                ec.status = Status::Released as u8;
                emit!(Released {
                    call_id: ec.call_id.clone()
                });
            }
            SettlementOutcome::Refund => {
                if remaining_amount > 0 {
                    let escrow_info = ctx.accounts.escrow_call.to_account_info();
                    let payer_info = ctx.accounts.payer.to_account_info();
                    pay_out(remaining_amount, &escrow_info, &payer_info)?;
                }
                let ec = &mut ctx.accounts.escrow_call;
                ec.status = Status::Refunded as u8;
                emit!(Refunded {
                    call_id: ec.call_id.clone()
                });
            }
        }
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(call_id: String)]
pub struct InitPayment<'info> {
    #[account(init, payer = payer, space = 8 + EscrowCall::MAX_LEN, seeds=[b"call", call_id.as_bytes()], bump)]
    pub escrow_call: Account<'info, EscrowCall>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Provider is recorded and later enforced
    pub provider: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fulfill<'info> {
    #[account(mut, seeds=[b"call", escrow_call.call_id.as_bytes()], bump)]
    pub escrow_call: Account<'info, EscrowCall>,
    pub provider: Signer<'info>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut, seeds=[b"call", escrow_call.call_id.as_bytes()], bump)]
    pub escrow_call: Account<'info, EscrowCall>,
    pub reporter: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds=[b"call", escrow_call.call_id.as_bytes()], bump, close = payer)]
    pub escrow_call: Account<'info, EscrowCall>,
    #[account(mut)]
    pub payer: SystemAccount<'info>,
    #[account(mut)]
    pub provider: SystemAccount<'info>,
}

#[account]
pub struct EscrowCall {
    pub call_id: String,
    pub payer: Pubkey,
    pub service_id: String,
    pub provider: Pubkey,
    pub amount: u64,
    pub start_ts: u64,
    pub sla_ms: u64,
    pub dispute_window_s: u64,
    pub status: u8, // 0 init, 1 fulfilled, 2 released, 3 refunded
    pub delivered_ts: Option<u64>,
    pub response_hash: [u8; 32],
    pub disputed: bool,
    pub total_units: u64,
    pub units_released: u64,
    pub provider_sig: Vec<u8>,
}

impl EscrowCall {
    pub const MAX_LEN: usize = 4 + 64 // call_id (Anchor stores string as length prefix + data)
        + 32 // payer
        + 4 + 64 // service_id
        + 32 // provider
        + 8 // amount
        + 8 // start_ts
        + 8 // sla_ms
        + 8 // dispute_window_s
        + 1 // status
        + 9 // delivered_ts (Option<u64>)
        + 32 // response_hash
        + 1 // disputed
        + 8 // total_units
        + 8 // units_released
        + 4 + MAX_PROVIDER_SIG_LEN; // provider_sig vec
}

#[event]
pub struct Fulfilled {
    pub call_id: String,
    pub ts: u64,
}
#[event]
pub struct Released {
    pub call_id: String,
}
#[event]
pub struct Refunded {
    pub call_id: String,
}
#[event]
pub struct Disputed {
    pub call_id: String,
    pub kind: u8,
    pub reason_hash: [u8; 32],
}
#[event]
pub struct PartialReleased {
    pub call_id: String,
    pub units: u64,
    pub total_units: u64,
}
#[event]
pub struct TraceSaved {
    pub call_id: String,
    pub response_hash: [u8; 32],
    pub provider_sig: Vec<u8>,
}

#[error_code]
pub enum AssuredError {
    #[msg("Invalid status")]
    InvalidStatus,
    #[msg("Invalid provider")]
    InvalidProvider,
    #[msg("Invalid payer")]
    InvalidPayer,
    #[msg("Invalid reporter")]
    InvalidReporter,
    #[msg("Escrow account underfunded")]
    EscrowBalanceLow,
    #[msg("Provider signature too long")]
    SignatureTooLong,
    #[msg("Invalid units for partial release")]
    InvalidUnits,
}

#[repr(u8)]
pub enum Status {
    Init = 0,
    Fulfilled = 1,
    Released = 2,
    Refunded = 3,
}

#[derive(PartialEq, Eq, Debug)]
pub enum SettlementOutcome {
    Release,
    Refund,
}

fn transfer_into_escrow<'info>(
    payer: &Signer<'info>,
    escrow: &Account<'info, EscrowCall>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer {
        from: payer.to_account_info(),
        to: escrow.to_account_info(),
    };
    system_program::transfer(
        CpiContext::new(system_program.to_account_info(), accounts),
        amount,
    )
}

fn pay_out<'info>(
    amount: u64,
    escrow: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(escrow.lamports() >= amount, AssuredError::EscrowBalanceLow);
    **escrow.try_borrow_mut_lamports()? -= amount;
    **destination.try_borrow_mut_lamports()? += amount;
    Ok(())
}

struct PartialReleaseState {
    payout: u64,
    units: u64,
    total_units: u64,
    emit_trace: bool,
}

fn apply_partial_release(
    ec: &mut EscrowCall,
    chunk_hash: [u8; 32],
    units: u64,
    ts: u64,
    provider_sig: &[u8],
) -> Result<PartialReleaseState> {
    require!(units > 0, AssuredError::InvalidUnits);
    let start_units = ec.units_released;
    let new_total = start_units
        .checked_add(units)
        .ok_or(AssuredError::InvalidUnits)?;
    require!(new_total <= ec.total_units, AssuredError::InvalidUnits);

    let payout = amount_for_units(ec, start_units, units);
    ec.units_released = new_total;
    ec.response_hash = chunk_hash;
    ec.provider_sig = provider_sig.to_vec();

    let mut emit_trace = false;
    if ec.units_released == ec.total_units {
        ec.delivered_ts = Some(ts);
        ec.status = Status::Fulfilled as u8;
        emit_trace = true;
    }

    Ok(PartialReleaseState {
        payout,
        units,
        total_units: ec.total_units,
        emit_trace,
    })
}

fn amount_for_units(ec: &EscrowCall, start: u64, units: u64) -> u64 {
    if units == 0 || ec.total_units == 0 {
        return 0;
    }
    let base = ec.amount / ec.total_units;
    let remainder = ec.amount % ec.total_units;
    let mut total = base * units;
    let remainder_units = remainder as u64;
    if remainder_units > start {
        let overlap_start = start;
        let overlap_end = remainder_units.min(start.saturating_add(units));
        if overlap_end > overlap_start {
            total = total.saturating_add(overlap_end - overlap_start);
        }
    }
    total
}

fn evaluate_settlement(ec: &EscrowCall, now: u64) -> SettlementOutcome {
    let delivered_within_sla = ec
        .delivered_ts
        .map(|ts| ts.saturating_sub(ec.start_ts) <= ec.sla_ms)
        .unwrap_or(false);
    let dispute_window_elapsed = ec
        .delivered_ts
        .map(|ts| now.saturating_sub(ts) >= ec.dispute_window_s)
        .unwrap_or(true);
    if !ec.disputed && delivered_within_sla && dispute_window_elapsed {
        SettlementOutcome::Release
    } else {
        SettlementOutcome::Refund
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_call() -> EscrowCall {
        EscrowCall {
            call_id: "call-1".to_string(),
            payer: Pubkey::default(),
            service_id: "svc".to_string(),
            provider: Pubkey::new_unique(),
            amount: 1_000_000,
            start_ts: 0,
            sla_ms: 2_000,
            dispute_window_s: 10,
            status: Status::Fulfilled as u8,
            delivered_ts: Some(1_000),
            response_hash: [0u8; 32],
            disputed: false,
            total_units: 1,
            units_released: 1,
            provider_sig: vec![],
        }
    }

    fn streaming_call(total_units: u64, amount: u64) -> EscrowCall {
        EscrowCall {
            call_id: "stream-call".to_string(),
            payer: Pubkey::default(),
            service_id: "svc".to_string(),
            provider: Pubkey::new_unique(),
            amount,
            start_ts: 0,
            sla_ms: 2_000,
            dispute_window_s: 10,
            status: Status::Init as u8,
            delivered_ts: None,
            response_hash: [0u8; 32],
            disputed: false,
            total_units,
            units_released: 0,
            provider_sig: vec![],
        }
    }

    #[test]
    fn amount_for_units_distributes_evenly() {
        let mut ec = base_call();
        ec.amount = 100;
        ec.total_units = 3;
        ec.units_released = 0;
        assert_eq!(amount_for_units(&ec, 0, 1), 34);
        assert_eq!(amount_for_units(&ec, 1, 1), 33);
        assert_eq!(amount_for_units(&ec, 2, 1), 33);
        assert_eq!(amount_for_units(&ec, 0, 3), 100);
    }

    #[test]
    fn partial_release_updates_units_and_flags_trace() {
        let mut ec = streaming_call(3, 90);
        let first = apply_partial_release(&mut ec, [1u8; 32], 1, 1_000, b"sig1").unwrap();
        assert_eq!(ec.units_released, 1);
        assert_eq!(ec.status, Status::Init as u8);
        assert_eq!(first.payout, 30);
        assert!(!first.emit_trace);
        assert_eq!(ec.provider_sig, b"sig1".to_vec());

        let second = apply_partial_release(&mut ec, [2u8; 32], 2, 2_000, b"sig2").unwrap();
        assert_eq!(ec.units_released, 3);
        assert_eq!(ec.status, Status::Fulfilled as u8);
        assert_eq!(ec.delivered_ts, Some(2_000));
        assert_eq!(second.payout, 60);
        assert!(second.emit_trace);
        assert_eq!(ec.provider_sig, b"sig2".to_vec());
    }

    #[test]
    fn partial_release_rejects_invalid_units() {
        let mut ec = streaming_call(2, 50);
        assert!(apply_partial_release(&mut ec, [1u8; 32], 0, 1_000, b"sig").is_err());
        assert!(apply_partial_release(&mut ec, [1u8; 32], 3, 1_000, b"sig").is_err());
    }

    #[test]
    fn settles_release_when_sla_met_and_no_dispute() {
        let ec = base_call();
        let outcome = evaluate_settlement(&ec, 12_000);
        assert_eq!(outcome, SettlementOutcome::Release);
    }

    #[test]
    fn settles_refund_when_disputed_or_sla_missed() {
        let mut disputed = base_call();
        disputed.disputed = true;
        let outcome = evaluate_settlement(&disputed, 12_000);
        assert_eq!(outcome, SettlementOutcome::Refund);

        let mut late = base_call();
        late.delivered_ts = Some(10_000);
        let outcome_late = evaluate_settlement(&late, 12_000);
        assert_eq!(outcome_late, SettlementOutcome::Refund);
    }
}
