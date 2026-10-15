-- ─────────────────────────────────────────────────────────────────────────────
-- 0007 Expected drawer cash during a peak session (the cashier-facing "Expected drawer total").
--
--   expected drawer cash = start cash
--                        + Σ peak bill totals           (peak bills record no tender: counted as cash)
--                        + Σ CASH bill tenders in the session (normal bills finished during the peak)
--                        + Σ CASH waiter repayments in the session
--                        − Σ cash expenses in the session
--
-- UPI never reaches the drawer, so UPI tenders and repayments are left out. A peak sale that was
-- actually paid by UPI makes the counted drawer lower by that amount; the session's variance, which
-- reconciles cash + UPI together, is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION pos_peak_expected_drawer_cash(p_session_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (
      s.peak_start_cash
    + coalesce((SELECT sum(b.total_paise) FROM bills b WHERE b.peak_session_id = s.id), 0)
    + coalesce((SELECT sum(p.amount_paise) FROM bill_payments p WHERE p.peak_session_id = s.id AND p.tender_type = 'CASH'), 0)
    + coalesce((SELECT sum(w.amount_paise) FROM waiter_payments w WHERE w.peak_session_id = s.id AND w.tender_type = 'CASH'), 0)
    - coalesce((SELECT sum(e.amount_paise) FROM cash_expenses e WHERE e.peak_session_id = s.id), 0)
  )::bigint
  FROM peak_sessions s
  WHERE s.id = p_session_id
$$;

-- Appends the running figure (NULL once the session has ended: its cash was counted).
CREATE OR REPLACE VIEW v_peak_sessions AS
SELECT ps.*,
       CASE WHEN ps.ended_at IS NULL THEN pos_peak_expected_paise(ps.id) ELSE ps.peak_expected_paise END
         AS running_expected_paise,
       CASE WHEN ps.ended_at IS NULL THEN pos_peak_expected_drawer_cash(ps.id) END
         AS expected_drawer_cash_paise
  FROM peak_sessions ps;
