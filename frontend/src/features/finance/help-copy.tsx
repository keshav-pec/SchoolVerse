import type { ReactNode } from 'react';

/**
 * Plain-language help for the Finance screens, kept in one place so the same idea is explained the same way everywhere.
 * Written for school office staff: short sentences and an everyday example.
 */

// ───────────────────────────────────────────────────────────── page and tab intros

export const OVERVIEW_INTRO: ReactNode = (
  <p>
    A quick look at the school’s fee money. Billed is what the school asked families to pay. Outstanding is what is still unpaid. Overdue is the part
    that is past its due date.
  </p>
);

export const CHECKLIST_INTRO: ReactNode = (
  <p>
    Finance needs a few things set up once. Each line below says if it is done. Press <b>Fix</b> on a line to go to the right place. GST is optional if the
    school is not registered for it.
  </p>
);

export const SCHOOL_TAX_INTRO: ReactNode = (
  <p>
    The school’s legal name and state decide how tax is worked out. Add the GSTIN only if the school is registered for GST. The tax codes below are{' '}
    <b>examples</b>. Please confirm them with your accountant.
  </p>
);

export const CHART_INTRO: ReactNode = (
  <p>
    The list of accounts where every rupee is recorded, such as Tuition Income or Bank. Most schools use <b>the standard chart</b> as it is. Accounts the
    system uses by itself are locked.
  </p>
);

export const YEARS_INTRO: ReactNode = (
  <p>
    A financial year runs from April to March, for example 2026-27. Adding a year also makes its 12 months. Money can only be recorded in a month that is
    open.
  </p>
);

export const BANK_INTRO: ReactNode = (
  <p>
    The school’s bank accounts and cash box. The full account number is hidden. Press <b>Show</b> and give a reason to see it. The school writes that
    reason down.
  </p>
);

export const APPROVALS_INTRO: ReactNode = (
  <p>
    Some changes need a second person to say yes, such as a big credit note or a bank detail change. Set the rules here, and decide the waiting requests
    below.
  </p>
);

export const ACCESS_INTRO: ReactNode = (
  <p>
    Choose what each staff member may do with school money. Tick one or more jobs. Only staff logins can have a finance job. A job never gives access to a
    campus the person does not work at.
  </p>
);

export const ACCOUNTS_INTRO: ReactNode = (
  <p>
    Every student has their own fee account. Search by the student’s name, admission number or a parent’s name. <b>Each child has a separate account.</b>{' '}
    A family page only adds them up on screen.
  </p>
);

export const PLANS_INTRO: ReactNode = (
  <p>
    A fee plan is the price list for a class: what is charged, how often, and when it is due. Publish a plan, then assign it to students. A published
    plan never changes. A new price is a new version.
  </p>
);

export const CONCESSIONS_INTRO: ReactNode = (
  <p>
    A concession is a discount, such as a sibling or staff-child discount. It lowers the bill. It is <b>not</b> a payment.
  </p>
);

export const BILLING_INTRO: ReactNode = (
  <p>
    Make the bills for a month in three steps: <b>Check</b>, fix what needs a look, then <b>Issue</b>. Running it again is safe. A student is never billed
    twice for the same month.
  </p>
);

export const ADJUSTMENTS_INTRO: ReactNode = (
  <p>
    An issued bill never changes. To correct one, make a credit note (less to pay) or a debit note (more to pay). The system shows the new balance before
    you save. There is no box to type a balance.
  </p>
);

// ───────────────────────────────────────────────────────────── "i" help cards

export const TIP_FEE_HEAD: ReactNode = (
  <p>
    A <b>fee head</b> is one kind of charge, like Tuition or Transport. Each one needs an income account and a tax code before it can be billed.
  </p>
);

export const TIP_PRORATION: ReactNode = (
  <>
    <p>What to charge when a student joins or leaves in the middle of a period.</p>
    <ul>
      <li>
        <b>Full period:</b> charge the whole period.
      </li>
      <li>
        <b>By days:</b> charge only the days the student is here. Example: 18 of 30 days × ₹4,000 = ₹2,400.
      </li>
      <li>
        <b>No charge:</b> charge nothing for a part period.
      </li>
    </ul>
  </>
);

export const TIP_STACK: ReactNode = (
  <>
    <p>What happens when a student has more than one concession.</p>
    <ul>
      <li>
        <b>Highest wins:</b> only the biggest discount is used.
      </li>
      <li>
        <b>Add together:</b> all discounts are added, but never above the cap.
      </li>
    </ul>
  </>
);

export const TIP_TAX_CODE: ReactNode = (
  <p>
    Most school tuition is usually exempt from GST, but not everything is. Uniforms, for example, may be taxable. Ask your accountant which code each fee
    needs.
  </p>
);

export const TIP_PRICE_INCLUDES_TAX: ReactNode = (
  <p>
    <b>Tax added on top:</b> the amount you enter is the price before tax. <b>Price includes tax:</b> the amount you enter is what the family pays, and the
    tax is taken out of it.
  </p>
);

export const TIP_ISSUED_BILL: ReactNode = (
  <p>An issued bill keeps its number and its amounts for ever. If something was wrong, make a credit note or a debit note. The old bill stays as it was.</p>
);

export const TIP_CONCESSION_VS_PAYMENT: ReactNode = (
  <p>A concession lowers what the family has to pay. A payment is money the school received. The two are kept apart, so the books always match the bank.</p>
);

export const TIP_EXPECTED_LATER: ReactNode = (
  <p>Fees for months that are not billed yet. They are shown here so you can plan, but they are <b>not</b> counted as owed until the bill is issued.</p>
);

export const TIP_OUTSTANDING: ReactNode = <p>What the family owes now, worked out from every bill and payment. It cannot be typed or edited.</p>;

export const TIP_ADVANCE: ReactNode = <p>Money the school holds for the student that is not matched to a bill yet. It is not income. It is used against future bills or refunded.</p>;

export const TIP_BUNDLES: ReactNode = (
  <p>A job is a group of permissions. A person can hold more than one job. Changes work straight away, with no need to sign out.</p>
);

// ───────────────────────────────────────────────────────────── plain words for reasons

/** Why a student or a bill row needs a look, in everyday words. */
export const REASON_TEXT: Record<string, string> = {
  NO_PLAN: 'No fee plan fits this class yet.',
  PLAN_CONFLICT: 'Two fee plans match. Choose the right one.',
  ALREADY_ASSIGNED: 'This student already has a fee plan.',
  NOT_ENROLLED: 'This student is not in a class this year.',
  TAX_CODE_MISSING: 'A fee type has no tax setting.',
  STUDENT_NOT_ENROLLED: 'This student is not in a class this month.',
  ALREADY_BILLED: 'Already billed for this month.',
  PERIOD_CLOSED: 'This month is closed for new entries.',
  AWARD_EXPIRED: 'A concession has ended.',
  NOTHING_DUE: 'Nothing is due this month.',
};

/** Group titles on the billing screen. */
export const REASON_GROUP_TITLE: Record<string, string> = {
  NO_PLAN: 'No fee plan',
  PLAN_CONFLICT: 'Two plans match',
  TAX_CODE_MISSING: 'Fee type has no tax setting',
  STUDENT_NOT_ENROLLED: 'Not in a class',
  PERIOD_CLOSED: 'Month is closed',
  AWARD_EXPIRED: 'Concession has ended',
  ALREADY_BILLED: 'Already billed',
  NOTHING_DUE: 'Nothing due',
};

export const AGING_LABELS: Record<string, string> = {
  CURRENT: 'Not due yet',
  D1_30: '1–30 days late',
  D31_60: '31–60 days late',
  D61_90: '61–90 days late',
  D90_PLUS: 'Over 90 days late',
};

export const FREQUENCY_LABELS: Record<string, string> = {
  ONE_TIME: 'Once',
  MONTHLY: 'Every month',
  QUARTERLY: 'Every 3 months',
  TERM: 'Every term',
  HALF_YEARLY: 'Every 6 months',
  YEARLY: 'Once a year',
};

export const PRORATION_LABELS: Record<string, string> = {
  FULL_PERIOD: 'Charge the full period',
  CALENDAR_DAYS: 'Charge by days',
  NONE: 'No charge for a part period',
};

export const CONCESSION_TYPE_LABELS: Record<string, string> = {
  SIBLING: 'Sibling',
  STAFF_CHILD: 'Staff child',
  MERIT: 'Merit',
  NEED: 'Need-based',
  SPORTS: 'Sports',
  MANAGEMENT: 'Management',
  SPONSOR: 'Sponsor',
};

export const FEE_CATEGORY_LABELS: Record<string, string> = {
  TUITION: 'Tuition',
  ADMISSION: 'Admission',
  ANNUAL: 'Annual',
  TRANSPORT: 'Transport',
  EXAM: 'Exam',
  ACTIVITY: 'Activity',
  DEPOSIT: 'Refundable deposit',
  LATE_FEE: 'Late fee',
  OTHER: 'Other',
};

export const APPROVAL_ACTION_LABELS: Record<string, string> = {
  REFUND: 'Refund',
  CREDIT_NOTE: 'Credit note',
  WAIVER: 'Waiver',
  CONCESSION: 'Concession',
  PAYROLL_FINALIZE: 'Payroll finalise',
  PERIOD_CLOSE: 'Close a month',
  BANK_DETAIL_CHANGE: 'Bank detail change',
  SYSTEM_ROLE_CHANGE: 'System account change',
  RECON_OVERRIDE: 'Bank matching override',
};

export const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
  WAIVER: 'Waiver',
  LATE_FEE_REVERSAL: 'Late fee reversal',
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  INCOME: 'Income',
  EXPENSE: 'Expenses',
  EQUITY: 'Equity',
};

export const BANK_PURPOSE_LABELS: Record<string, string> = { FEES: 'Fees', SALARY: 'Salary', OPERATING: 'Operating' };

export const TAX_CATEGORY_LABELS: Record<string, string> = {
  EXEMPT: 'Exempt',
  NIL_RATED: 'Nil rated',
  OUT_OF_SCOPE: 'Out of scope',
  TAXABLE: 'Taxable',
};

export const LEDGER_KIND_LABELS: Record<string, string> = {
  BILL: 'Bill',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
  PAYMENT: 'Payment',
  ADVANCE_IN: 'Advance received',
  ADVANCE_USED: 'Advance used',
  REFUND: 'Refund',
  REVERSAL: 'Reversal',
};
