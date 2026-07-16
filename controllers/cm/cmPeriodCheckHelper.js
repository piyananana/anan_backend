// controllers/cm/cmPeriodCheckHelper.js
// Shared helper: check cm_status for a doc_date before allowing CM transactions
'use strict';

/**
 * Checks whether CM posting is allowed for a given date.
 * @param {object} pool  - pg Pool or client (must have .query)
 * @param {string} docDate - ISO date string 'YYYY-MM-DD'
 * @returns {{ allowed: boolean, message?: string, period?: object }}
 */
const checkCmPeriodOpen = async (pool, docDate) => {
    if (!docDate) return { allowed: false, message: 'ต้องระบุวันที่เอกสาร' };

    let result;
    try {
        result = await pool.query(
            `SELECT p.id, p.period_name, p.period_start_date, p.period_end_date,
                    COALESCE(p.cm_status, 'OPEN') AS cm_status
             FROM gl_posting_period p
             JOIN gl_fiscal_year fy ON fy.id = p.fiscal_year_id
             WHERE fy.is_active = true
               AND p.period_start_date::date <= $1::date
               AND p.period_end_date::date   >= $1::date
             ORDER BY p.period_start_date DESC
             LIMIT 1`,
            [docDate]
        );
    } catch (err) {
        // If cm_status column does not exist yet, allow posting (graceful degradation)
        if (err.message && err.message.includes('cm_status')) {
            return { allowed: true };
        }
        throw err;
    }

    if (result.rows.length === 0) {
        return { allowed: false, message: `ไม่พบงวดบัญชีสำหรับวันที่ ${docDate}` };
    }

    const period = result.rows[0];
    const cmStatus = period.cm_status || 'OPEN';

    if (cmStatus === 'OPEN') return { allowed: true, period };

    const statusLabel = cmStatus === 'LOCKED' ? 'ล็อค (LOCKED)' : 'ปิด (CLOSED)';
    return {
        allowed: false,
        message:  `งวดบัญชี CM "${period.period_name}" มีสถานะ${statusLabel} ไม่สามารถบันทึกรายการได้`,
        period,
    };
};

module.exports = { checkCmPeriodOpen };
