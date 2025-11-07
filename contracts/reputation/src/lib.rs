use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

const ESCROW_PROGRAM_ID: Pubkey = pubkey!("6zpAcx4Yo9MmDf4w8pBGez8bm47zyKuyjr5Y5QkC3ayL");
const EWMA_ALPHA: f64 = 0.2;
const QUANTILE_INC: f64 = 0.05;
const QUANTILE_DEC: f64 = 0.01;

declare_id!("8QFXHzWC1hDC7GQTNqBhsVRLURpYfXFBzT5Vb4NTxDh5");

#[program]
pub mod reputation {
    use super::*;

    pub fn update_weighted(
        ctx: Context<Update>,
        service_id: String,
        outcome: u8,
        weight_f32: f32,
    ) -> Result<()> {
        let svc = &mut ctx.accounts.service;
        if svc.owner == Pubkey::default() {
            svc.owner = ctx.accounts.payer.key();
        } else {
            require_keys_eq!(
                svc.owner,
                ctx.accounts.payer.key(),
                ReputationError::InvalidOwner
            );
        }
        let w = weight_f32.clamp(0.0, 1.0);
        svc.apply_outcome(outcome, w);
        let _ = service_id; // seeds bind PDA; suppress unused
        Ok(())
    }

    pub fn bond_deposit(ctx: Context<Bond>, service_id: String, amount: u64) -> Result<()> {
        require!(amount > 0, ReputationError::InvalidAmount);
        let service_info = ctx.accounts.service.to_account_info();
        transfer_into_service(
            &ctx.accounts.provider,
            &service_info,
            &ctx.accounts.system_program,
            amount,
        )?;
        let svc = &mut ctx.accounts.service;
        if svc.owner == Pubkey::default() {
            svc.owner = ctx.accounts.provider.key();
        }
        require_keys_eq!(
            svc.owner,
            ctx.accounts.provider.key(),
            ReputationError::InvalidOwner
        );
        svc.bond_balance = svc.bond_balance.saturating_add(amount);
        let _ = service_id;
        Ok(())
    }

    pub fn bond_withdraw(ctx: Context<Bond>, service_id: String, amount: u64) -> Result<()> {
        require!(amount > 0, ReputationError::InvalidAmount);
        {
            let svc = &mut ctx.accounts.service;
            require_keys_eq!(
                svc.owner,
                ctx.accounts.provider.key(),
                ReputationError::InvalidOwner
            );
            require!(
                svc.bond_balance >= amount,
                ReputationError::InsufficientBond
            );
        }

        let service_info = ctx.accounts.service.to_account_info();
        let provider_info = ctx.accounts.provider.to_account_info();
        pay_out(amount, &service_info, &provider_info)?;

        let svc = &mut ctx.accounts.service;
        svc.bond_balance = svc.bond_balance.saturating_sub(amount);
        let _ = service_id;
        Ok(())
    }

    pub fn bond_slash(ctx: Context<BondSlash>, service_id: String, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ESCROW_PROGRAM_ID,
            ReputationError::InvalidAuthority
        );
        let actual = {
            let svc = &ctx.accounts.service;
            amount.min(svc.bond_balance)
        };
        if actual > 0 {
            let service_info = ctx.accounts.service.to_account_info();
            let recipient_info = ctx.accounts.recipient.to_account_info();
            pay_out(actual, &service_info, &recipient_info)?;
            let svc = &mut ctx.accounts.service;
            svc.bond_balance = svc.bond_balance.saturating_sub(actual);
        }
        let _ = service_id;
        Ok(())
    }

    pub fn update_latency(
        ctx: Context<UpdateLatency>,
        service_id: String,
        sample_ms: u64,
    ) -> Result<()> {
        let svc = &mut ctx.accounts.service;
        if svc.owner == Pubkey::default() {
            svc.owner = ctx.accounts.provider.key();
        }
        require_keys_eq!(
            svc.owner,
            ctx.accounts.provider.key(),
            ReputationError::InvalidOwner
        );
        svc.record_latency(sample_ms);
        let _ = service_id;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(service_id: String)]
pub struct Update<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Service::MAX_LEN,
        seeds=[b"svc", service_id.as_bytes()],
        bump
    )]
    pub service: Account<'info, Service>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(service_id: String)]
pub struct Bond<'info> {
    #[account(
        mut,
        seeds=[b"svc", service_id.as_bytes()],
        bump
    )]
    pub service: Account<'info, Service>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(service_id: String)]
pub struct BondSlash<'info> {
    #[account(
        mut,
        seeds=[b"svc", service_id.as_bytes()],
        bump
    )]
    pub service: Account<'info, Service>,
    /// CHECK: validated against known program id
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
}

#[derive(Accounts)]
#[instruction(service_id: String)]
pub struct UpdateLatency<'info> {
    #[account(
        mut,
        seeds=[b"svc", service_id.as_bytes()],
        bump
    )]
    pub service: Account<'info, Service>,
    pub provider: Signer<'info>,
}

#[account]
pub struct Service {
    pub owner: Pubkey,
    pub ok: f32,
    pub late: f32,
    pub disputed: f32,
    pub bond_balance: u64,
    pub ewma_latency_ms: u64,
    pub p95_est_ms: u64,
    pub latency_samples: u64,
}

impl Service {
    pub const MAX_LEN: usize = 32 // owner
        + 4 * 3 // outcome weights
        + 8 // bond balance
        + 8 // ewma latency
        + 8 // p95 estimate
        + 8; // sample count

    pub fn apply_outcome(&mut self, outcome: u8, weight: f32) {
        match outcome {
            0 => self.ok += weight,
            1 => self.late += weight,
            2 => self.disputed += weight,
            _ => {}
        }
    }

    pub fn record_latency(&mut self, sample_ms: u64) {
        let sample = sample_ms as f64;
        if self.latency_samples == 0 {
            self.ewma_latency_ms = sample_ms;
            self.p95_est_ms = sample_ms;
        } else {
            let current_ewma = self.ewma_latency_ms as f64;
            let ewma = EWMA_ALPHA * sample + (1.0 - EWMA_ALPHA) * current_ewma;
            self.ewma_latency_ms = ewma.round().clamp(0.0, f64::MAX) as u64;

            let current_p95 = self.p95_est_ms as f64;
            let diff = sample - current_p95;
            let next_p95 = if diff >= 0.0 {
                current_p95 + diff * QUANTILE_INC
            } else {
                current_p95 + diff * QUANTILE_DEC
            };
            self.p95_est_ms = next_p95.max(0.0).round() as u64;
        }
        self.latency_samples = self.latency_samples.saturating_add(1);
    }
}

impl Default for Service {
    fn default() -> Self {
        Self {
            owner: Pubkey::default(),
            ok: 0.0,
            late: 0.0,
            disputed: 0.0,
            bond_balance: 0,
            ewma_latency_ms: 0,
            p95_est_ms: 0,
            latency_samples: 0,
        }
    }
}

fn transfer_into_service<'info>(
    provider: &Signer<'info>,
    service: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer {
        from: provider.to_account_info(),
        to: service.clone(),
    };
    system_program::transfer(
        CpiContext::new(system_program.to_account_info(), accounts),
        amount,
    )
}

fn pay_out<'info>(
    amount: u64,
    source: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(
        source.lamports() >= amount,
        ReputationError::InsufficientBond
    );
    **source.try_borrow_mut_lamports()? -= amount;
    **destination.try_borrow_mut_lamports()? += amount;
    Ok(())
}

#[error_code]
pub enum ReputationError {
    #[msg("Invalid owner for operation")]
    InvalidOwner,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Insufficient bonded balance")]
    InsufficientBond,
    #[msg("Invalid authority")]
    InvalidAuthority,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_ok_outcome() {
        let mut svc = Service::default();
        svc.apply_outcome(0, 0.5);
        assert!((svc.ok - 0.5).abs() < f32::EPSILON);
        assert_eq!(svc.late, 0.0);
        assert_eq!(svc.disputed, 0.0);
    }

    #[test]
    fn applies_other_outcomes() {
        let mut svc = Service::default();
        svc.apply_outcome(1, 1.0);
        svc.apply_outcome(2, 0.25);
        assert_eq!(svc.ok, 0.0);
        assert!((svc.late - 1.0).abs() < f32::EPSILON);
        assert!((svc.disputed - 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn record_latency_initialises_and_tracks() {
        let mut svc = Service::default();
        svc.record_latency(150);
        assert_eq!(svc.ewma_latency_ms, 150);
        assert_eq!(svc.p95_est_ms, 150);
        assert_eq!(svc.latency_samples, 1);

        svc.record_latency(450);
        assert_eq!(svc.latency_samples, 2);
        assert!(svc.ewma_latency_ms >= 150);
        assert!(svc.p95_est_ms >= 150);
    }
}
