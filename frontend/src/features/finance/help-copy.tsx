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
  RECEIPT_CANCEL: 'Cancel a receipt',
  ADVANCE_TRANSFER: 'Move an advance',
  MANUAL_JOURNAL: 'Hand-made entry',
  PERIOD_REOPEN: 'Reopen a month',
  EXPENSE: 'Expense',
  VENDOR_BILL: 'Vendor bill',
  SALARY_REVISION: 'Salary change',
  VENDOR_BANK_CHANGE: 'Vendor bank change',
  BANK_CHARGE_NOTE: 'Bank charge note',
  LOAN_CHANGE: 'Advance plan change',
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


// ───────────────────────────────────────────────────────────── Part 4: collections

export const TAKE_PAYMENT_INTRO: ReactNode = (
  <p>
    Find the student, check the bills, choose how the family paid, and press <b>Save Payment</b>. The oldest bills are paid first. Cash gives a
    receipt at once. UPI, bank transfer and cheque wait until the money is checked in the bank.
  </p>
);

export const VERIFY_INTRO: ReactNode = (
  <p>
    Payments that parents or staff reported, oldest first. Check each one against the bank, then press <b>Verify</b>. The family gets the receipt only
    after that. <b>A UTR alone is not proof. We check it in the bank.</b>
  </p>
);

export const CHEQUES_INTRO: ReactNode = (
  <p>
    Every cheque the office received, by what happened to it. <b>A receipt is made only after the cheque clears.</b> If the bank returns it, the bill
    comes back as unpaid.
  </p>
);

export const RECEIPTS_INTRO: ReactNode = <p>Every receipt the school has issued. A receipt never changes. If one was wrong, cancel it with a reason. Big amounts need a second person.</p>;

export const REFUNDS_INTRO: ReactNode = (
  <p>
    Money the school gives back, such as an unused advance or a refundable deposit. <b>Approving is not paying.</b> Record the payment only after the
    money has left the bank.
  </p>
);

export const SHIFT_INTRO: ReactNode = (
  <p>
    Open a shift before taking cash. At the end of the day count the cash and close the shift. The system shows what it expected and any difference.
  </p>
);

export const TIP_CLAIM_VS_COLLECTION: ReactNode = (
  <p>
    A <b>claim</b> is someone saying “I paid”. A <b>payment</b> is money the school has checked and received. Only a checked payment pays a bill and
    makes a receipt.
  </p>
);

export const TIP_VERIFY: ReactNode = <p>Verify means you saw this money in the school’s bank statement or bank app, with the same amount and reference.</p>;

export const TIP_ALLOCATE: ReactNode = <p>Allocate means deciding which bills a payment pays. By default the oldest bill is paid first. Any money left over is kept as an advance.</p>;

// ───────────────────────────────────────────────────────────── Part 4: banking

export const BANKING_INTRO: ReactNode = (
  <p>
    Upload the bank statement and the system matches each line to a payment, deposit, refund or salary. You only look at the lines it could not match.
  </p>
);

export const TIP_RECONCILE: ReactNode = <p>Reconcile means checking that the school’s books and the bank statement say the same thing, line by line.</p>;

export const TIP_TIMING_DIFFERENCE: ReactNode = (
  <p>
    Something the school recorded that the bank has not shown yet, such as a cheque deposited today. It usually clears by itself in a few days. It is
    not a mistake.
  </p>
);

// ───────────────────────────────────────────────────────────── Part 4: payroll

export const PAYROLL_INTRO: ReactNode = (
  <p>
    Each month: <b>Calculate</b> and fix the people who need action. Then a different person with approval rights presses <b>Approve</b> and
    <b>Finalize</b>. The ready rows stay folded away.
  </p>
);

export const SALARY_SETUP_INTRO: ReactNode = (
  <p>Salary parts (like Basic and HRA), salary structures, and who gets which salary. A change to someone’s pay needs a second person.</p>
);

export const INPUTS_INTRO: ReactNode = <p>Days paid and unpaid leave for each person this month, plus any one-off extra pay or deduction. A missing month blocks the payroll run.</p>;

export const ADVANCES_INTRO: ReactNode = <p>A salary advance is money given early and taken back from future salaries in equal parts.</p>;

export const PAYMENTS_INTRO: ReactNode = (
  <p>
    Make the bank file, upload it in your bank, then record what the bank paid. <b>Making the file does not pay anyone.</b> A second person checks the
    payment.
  </p>
);

export const PAYSLIPS_INTRO: ReactNode = <p>Staff see their payslip only after you press <b>Publish Payslips</b>. A payslip never changes. A mistake is fixed with a correction run.</p>;

export const TIP_STATUTORY: ReactNode = (
  <p>
    Statutory rules are the PF, ESI and Professional Tax settings. The ones that came with SchoolVerse are <b>examples</b>. Your accountant must check and
    approve them.
  </p>
);

export const TIP_EMPLOYER_COST: ReactNode = <p>Employer cost is what the school pays on top of the salary, such as the school’s share of PF and ESI. It is not taken from the employee.</p>;

export const TIP_CORRECTION_RUN: ReactNode = <p>A finalised payroll never changes. If something was wrong, a correction run pays or takes back only the difference.</p>;

export const PAYROLL_EXCEPTION_LABELS: Record<string, string> = {
  MISSING_INPUT: 'Days not entered',
  NO_SALARY_ASSIGNED: 'No salary set',
  PENDING_REVISION: 'Pay change waiting',
  BANK_UNVERIFIED: 'Bank details missing',
  NEGATIVE_NET: 'Deductions more than pay',
  ADVANCE_EXCEEDS_NET: 'Advance more than pay',
  JOINED_OR_EXITED_THIS_MONTH: 'Joined or left this month',
  RULE_UNAPPROVED: 'Rules not approved',
};

export const RUN_TYPE_LABELS: Record<string, string> = { MONTHLY: 'Monthly', SUPPLEMENTARY: 'Extra pay', CORRECTION: 'Correction', FULL_FINAL: 'Full & final' };

export const COMPONENT_TYPE_LABELS: Record<string, string> = { EARNING: 'Pay', DEDUCTION: 'Deduction', EMPLOYER_COST: 'Employer cost' };
export const COMPONENT_CALC_LABELS: Record<string, string> = { FIXED: 'Fixed amount', PERCENT_OF_BASIC: '% of Basic', PERCENT_OF_GROSS: '% of Gross' };

// ───────────────────────────────────────────────────────────── Part 4: expenses and tax

export const EXPENSES_INTRO: ReactNode = <p>Record money the school spent. Type the amount and pick a category. The account, campus and month are filled in for you.</p>;

export const VENDORS_INTRO: ReactNode = <p>Suppliers the school buys from, their bills, and what the school still owes them. A change to a vendor’s bank details needs a second person.</p>;

export const TAX_INTRO: ReactNode = (
  <p>
    The GST working for one month. Fix the <b>Needs Review</b> items first. The downloads are a <b>working copy, not a filed return</b>. Your accountant
    files the return.
  </p>
);

export const TIP_ITC: ReactNode = (
  <>
    <p>
      <b>ITC</b> (input tax credit) is GST the school paid on a purchase that it may take back. Schools often have mostly exempt fees. Your accountant
      decides what to claim.
    </p>
    <ul>
      <li>
        <b>Claim:</b> the tax is kept to set off against GST the school owes.
      </li>
      <li>
        <b>Don’t claim:</b> the tax is added to the cost.
      </li>
      <li>
        <b>Decide later:</b> the expense waits until someone decides.
      </li>
    </ul>
  </>
);

export const ITC_LABELS: Record<string, string> = { ELIGIBLE: 'Claim', NOT_ELIGIBLE: 'Don’t Claim', NEEDS_REVIEW: 'Decide Later' };
export const EXPENSE_MODE_LABELS: Record<string, string> = { BANK: 'Paid from bank', CASH: 'Paid in cash', UNPAID: 'Not paid yet (owed to vendor)' };

// ───────────────────────────────────────────────────────────── Part 4: accounting and close

export const ACCOUNTING_INTRO: ReactNode = <p>The school’s books: every entry, each account, and the trial balance. Every entry links back to the bill, receipt or payslip it came from.</p>;

export const CLOSE_INTRO: ReactNode = (
  <p>
    Closing a month stops new entries in it, so the reports stay the same. Fix the <b>Must fix</b> items first. <b>Can accept</b> items need a short
    note. Closing needs a second person.
  </p>
);

export const TIP_CLOSE_PERIOD: ReactNode = <p>A closed month takes no new entries. A late correction goes into the next open month. Reopening needs a reason and a second person.</p>;

export const REPORTS_INTRO: ReactNode = <p>Each report says what it is based on. “Posted journals” is the accountant’s view. “Money received” is the cash view.</p>;

export const ATTENTION_INTRO: ReactNode = <p>Everything in Finance that needs a person, grouped. Press <b>Fix</b> to go straight to the right screen.</p>;

export const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  UPI: 'UPI',
  NEFT: 'Bank transfer (NEFT)',
  RTGS: 'Bank transfer (RTGS)',
  IMPS: 'Bank transfer (IMPS)',
  BANK_DEPOSIT: 'Paid into bank',
  OTHER: 'Other',
};

export const FLAG_LABELS: Record<string, string> = {
  DUPLICATE_SUSPECTED: 'Maybe a duplicate: the same reference or amount was reported before.',
  AMOUNT_MISMATCH: 'The amount differs from what the bank shows.',
  BANK_CREDIT_NOT_FOUND: 'Not found in the bank statement yet.',
};
