use anchor_lang::prelude::*;

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
        let w = weight_f32.clamp(0.0, 1.0);
        svc.apply_outcome(outcome, w);
        let _ = service_id; // seeds bind PDA; suppress unused
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

#[account]
pub struct Service {
    pub ok: f32,
    pub late: f32,
    pub disputed: f32,
}

impl Service {
    pub const MAX_LEN: usize = 4 * 3;

    pub fn apply_outcome(&mut self, outcome: u8, weight: f32) {
        match outcome {
            0 => self.ok += weight,
            1 => self.late += weight,
            2 => self.disputed += weight,
            _ => {}
        }
    }
}

impl Default for Service {
    fn default() -> Self {
        Self {
            ok: 0.0,
            late: 0.0,
            disputed: 0.0,
        }
    }
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
}
