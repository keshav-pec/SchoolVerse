# Module 7 — Fees, Billing, Payroll & Financial Management
## Non-Technical Walkthrough & PM Demo Guide

> **Who this is for:** Anyone presenting Module 7 to a Product Manager, school principal, or non-technical stakeholder. Every example uses the seed data from Greenfield Public School (Mohali campus, session 2026-27).

> **How to use this guide:** Walk through each section in order. Each section opens with *what* the feature does and *why* it matters, then gives a concrete click-by-click example using Greenfield's sample data. Sections are separated by horizontal rules.

---

## 1 · Finance Overview — "The Dashboard"

### What it does
The Finance Overview is the first screen anyone sees when they open the Finance section. It answers the three questions every school principal asks every morning:

- **How much did we bill this month?**
- **How much is still unpaid?**
- **How much is overdue (past the due date)?**

Below those numbers, a "Pulse" section shows real-time operational numbers: today's collections, payroll payable, monthly expenses, and cash in hand. A yellow banner at the top tells you how many things need a human — clicking it goes straight to the Needs Attention page.

### Why it matters
The principal or finance head no longer needs to ask the accountant for a summary. They open this page, and the numbers are there, live.

### Example Walkthrough

1. **Log in** as the School Admin (`admin@greenfield.demo`).
2. **Navigate** to **Finance → Overview** in the sidebar.
3. You see three tiles at the top:
   - **Billed this month:** Shows the total bills generated for November 2026 — for example, ₹1,20,000 across 15 bills for Class VIII.
   - **Outstanding:** The total amount families still owe — across all issued bills.
   - **Overdue:** The portion of outstanding that is past the due date (shown in red). October bills due on Oct 10 that haven't been paid show up here.
4. Below, in the **Pulse** section:
   - **Collections today:** Money received and checked today — e.g., ₹7,500 (the two payments from yesterday that were verified).
   - **Bank lines not matched:** Shows `3` — three lines from the imported State Bank statement that nobody has explained yet (SMS charge, interest credit, unknown NEFT).
5. The **yellow attention banner** shows "5 things need attention" — click it to see what they are.
6. **Quick actions** row shows buttons like "Take Payment", "Generate Bills", "Process Payroll" — each only visible if you have permission.
7. The **Setup Checklist** card says "Everything is set up" (with the seed data, all checklist items are done).
8. The **Outstanding aging chart** shows bars: Current, 1-30 days overdue, 31-60, 61-90, 90+.

**Talking point for the PM:** *"This page replaces the morning WhatsApp from the accountant. The principal opens it and knows exactly where the school's money stands."*

---

## 2 · Finance Settings — "Set Up Once, Use All Year"

### What it does
Finance Settings is the one-time configuration that powers everything else. It has seven tabs:

| Tab | What it does |
|---|---|
| **Setup Checklist** | A progress tracker — shows what's done and what still needs setup |
| **School & Tax** | The school's legal name, state, GSTIN, and tax codes |
| **Chart of Accounts** | The accounting ledger structure (Tuition Income, Bank, etc.) |
| **Years & Periods** | Financial years (April to March) and their 12 monthly periods |
| **Bank & Cash** | The school's bank accounts and cash boxes |
| **Approvals** | Rules for what needs a second person's sign-off |
| **Access** | Which staff member can do which finance jobs |

### Example Walkthrough

1. Navigate to **Finance → Settings**.
2. **Setup Checklist** tab: Every line shows a green check ✓. If the school had just started, items like "Add a bank account" would show a yellow dot with a "Fix" link.
3. **School & Tax** tab:
   - Legal name: *Greenfield Public School Trust*
   - GSTIN: `03AAAAA0000A1Z5`
   - GST registered: Yes
   - Tax codes listed: `EXEMPT_EDU` (most school fees), `GST_12` (12% — used for Uniform fees), etc.
   - A note at the top says: *"The tax codes below are examples. Please confirm them with your accountant."*
4. **Chart of Accounts** tab: Shows the standard school chart —
   - `4100 · Tuition Income` (locked — the system uses it)
   - `4300 · Annual Charges Income`
   - `4400 · Transport Income`
   - `2200 · Security Deposit Liability`
   - `1100 · State Bank of India` (linked to the bank account)
5. **Years & Periods** tab: Shows FY `2026-27` with 12 monthly periods (April 2026 to March 2027). Each period shows `OPEN` or `CLOSED`.
6. **Bank & Cash** tab:
   - **Fees account (State Bank)** — State Bank of India, account ••••1234, IFSC SBIN0001234, purpose: Fees, linked to Mohali campus.
   - **Front office cash** — the cash box for walk-in payments.
   - The full account number is hidden. Press "Show" and you must type a reason — the system logs who looked and why.
7. **Access** tab: Shows two staff members with finance jobs:
   - `accounts@greenfield.demo` — Accountant, Fee Manager, Collector, Payroll Officer
   - `approver@greenfield.demo` — Approver

**Talking point for the PM:** *"This is the 'do it once' setup. A school configures this in the first week. After that, they rarely come back here. The checklist makes sure nothing is missed."*

---

## 3 · Fee Plans — "The Price List for Each Class"

### What it does
A Fee Plan is the price list for a group of students. It says: *"Class VIII at Mohali pays ₹4,000/month for Tuition, ₹8,000/year for Annual Charges, ₹1,500/quarter for Computer, and ₹2,000/term for Exams."*

Plans have versions. A published plan is frozen — it can never be changed. If fees go up, you create a new version. This is an audit trail.

### Example Walkthrough

1. Navigate to **Finance → Student Fees → Fee Plans** tab.
2. You see the plan **"Class VIII 2026-27"**:
   - Applies to: **Mohali campus, Class VIII, All students**
   - Auto-assign: **Yes** (every student enrolled in Class VIII at Mohali automatically gets this plan)
   - Version 1 is **Published** ✓
3. Click the plan to see its **line items**:

   | Fee Head | Amount | Frequency | Due Day | Proration |
   |---|---|---|---|---|
   | Tuition Fee | ₹4,000 | Monthly | 10th | By calendar days |
   | Annual Charges | ₹8,000 | Yearly | 10th | Full period |
   | Computer Fee | ₹1,500 | Quarterly | 10th | Full period |
   | Examination Fee | ₹2,000 | Per Term | 10th | Full period |
   | Security Deposit | ₹5,000 | One-time | 10th | Full period |
   | Transport Fee | ₹1,200 | Monthly | 10th | *Optional* |
   | Uniform | ₹1,500 | One-time | 10th | *Optional* |

4. Notice that **Transport** and **Uniform** are marked *optional* — they only appear on the bill if the student opted in.
5. The **"Nursery to Class VII 2026-27"** plan shows lower amounts: Tuition ₹3,000/month, Annual ₹6,000/year, Exam ₹1,500/term.
6. The **"Classes IX to XII 2026-27"** plan shows higher amounts: Tuition ₹4,500/month, Annual ₹9,000/year, etc.

**Talking point for the PM:** *"The school never types a fee amount on a bill. The plan decides everything. And once it's published, it's locked — so there's always a clean record of what the fees were."*

---

## 4 · Concessions — "Discounts That Explain Themselves"

### What it does
A concession is a discount — sibling discount, staff-child waiver, merit scholarship, etc. It's **not** a payment. It reduces what the bill asks for. The system can automatically find siblings and suggest concessions.

### Example Walkthrough

1. Navigate to **Finance → Student Fees → Concessions** tab.
2. You see two policies:
   - **Sibling concession** — Type: Sibling, 10% off Tuition, stacking: Highest wins, cap: 50%, no evidence needed, no approval needed.
   - **Staff child concession** — Type: Staff child, 50% off Tuition, stacking: Highest wins, **needs approval** (a second person must say yes).
3. The system has already **auto-detected siblings**. Riya Kaur (Class VI) and Arjun Kaur (Class VIII) share a parent. The younger sibling (Riya) got the 10% sibling concession on her Tuition fee.
4. Click on a student who has the sibling concession — you can see the concession on their fee account: *"Sibling concession: 10% off Tuition Fee = ₹300 off per month."*

**Talking point for the PM:** *"The school doesn't have to remember who has a sibling. The system finds siblings from the student-parent relationships in Module 4 and suggests the discount. The accountant just approves."*

---

## 5 · Billing — "Generate Bills in Three Steps"

### What it does
Billing is how the school tells every family what they owe for a given month. It works in three steps:

1. **Check** — The system looks at every student's plan, finds who to bill, and flags exceptions (no plan, duplicate plan, missing tax code).
2. **Review** — The staff looks at the exceptions and fixes them (or skips those students).
3. **Issue** — Press the button, and the bills are created. Each bill gets a unique number that never repeats.

Running it again is safe. A student is never billed twice for the same month.

### Example Walkthrough

1. Navigate to **Finance → Student Fees → Billing** tab.
2. You see the billing runs:
   - **October 2026** — Status: **Issued** ✓ — Bills were generated for all Class VIII students at Mohali on Oct 5.
   - **November 2026** — Status: **Checked** (not yet issued in the demo, so the exceptions are visible).
3. Click on the **November 2026** run to see the preview:
   - **Ready:** Most students — the system calculated their bill and it's correct.
   - **Needs Attention:** A few exceptions are flagged:
     - *"Student X matches two plans (Scholar Plan A and Scholar Plan B)"* — someone set up two plans for the same student.
     - *"Student Y's plan uses Sports Fee, which has no tax code"* — the fee head is missing a tax code setting.
     - *"Student Z has no fee plan assigned"* — this student was enrolled but never got a plan.
   - Each exception has a **Fix** link that takes you directly to the place to fix it.
4. For a ready student, click to see the **bill preview**:
   - Tuition Fee: ₹4,000
   - Computer Fee: ₹1,500 (Q3 2026)
   - Total: ₹5,500
   - Due: November 10, 2026
5. Once all exceptions are resolved, press **Issue** — the bills are created and show up in each student's account.

**Talking point for the PM:** *"The school doesn't hand-type bills. The system does the work and shows only the problems. The accountant's job is to fix the exceptions, not to do the routine."*

---

## 6 · Student Fee Accounts — "Every Rupee, Explained"

### What it does
Every student has their own fee account. It shows:
- **Outstanding** — total owed right now
- **Overdue** — what's past the due date
- **Advance** — money paid ahead (the school owes this back)
- Every bill, every payment, every credit note, in order

A family view adds up the children's accounts on screen, but each child's money is tracked separately.

### Example Walkthrough

1. Navigate to **Finance → Student Fees → Accounts** tab.
2. Search for **"Arjun Kaur"** (admission number GPS/2021/00042, Class VIII).
3. His account page shows:
   - **Outstanding:** ₹5,500 (the November bill not yet paid)
   - **Overdue:** ₹5,500 (the October bill was due Oct 10 and was paid by a parent's UPI, but not all may be cleared)
   - **Advance:** ₹0
4. Below, see the **ledger** — a timeline of everything:
   - Oct 5: Bill #BILL/2026-27/000012 — ₹5,500 (Oct bill issued)
   - Oct 20: Payment — ₹4,000 UPI (UTR 4821 0000 1111) — verified ✓
   - Nov 5: Bill #BILL/2026-27/000025 — ₹5,500 (Nov bill issued)
5. Click any bill to see the **line-by-line detail**: Tuition ₹4,000, Computer ₹1,500, any concession applied, tax breakdown.
6. Click **"Family view"** — you see both Arjun (Class VIII) and Riya (Class VI) under the same parent (Harpreet Kaur). The page adds up both accounts but each child's tab stays separate.

**Talking point for the PM:** *"Parents call and ask 'why do I owe ₹11,000?' The front office opens this screen and walks them through every line. No guessing, no spreadsheets."*

---

## 7 · Collect Payments — "Take Fees, Check, Give Receipts"

### What it does
This is where the school records money coming in. It has six tabs:

| Tab | What happens |
|---|---|
| **Take Payment** | Record a payment at the counter (cash, UPI, cheque, bank transfer) |
| **Waiting for Verification** | Payments that need someone to confirm the money actually arrived |
| **Cheques** | Track cheque lifecycle (received → deposited → cleared / bounced) |
| **Receipts** | Browse and reprint official receipts |
| **Refunds** | Process money going back to a family |
| **My Shift** | Cash box management for the front desk |

### Example Walkthrough

1. Navigate to **Finance → Collect Payments**.
2. **Take Payment** tab: Select student "Arjun Kaur", enter ₹5,500, select method "UPI", enter reference "UTR 9988 7766 5544", select the bank account, and submit. The system checks for duplicates (same UTR + amount) and flags if suspicious.
3. **Waiting for Verification** tab (shows a badge with the count):
   - You see two entries from the seed data:
     - **UPI claim** — ₹4,000 from a parent (UTR 4821 0000 1111) reported by staff. Status: waiting.
     - **NEFT** — ₹3,500 from Harjit Singh (NEFT 5566 7788). Status: waiting.
   - For each, the verifier clicks **Verify**, confirms the amount seen in the bank, selects the bank account, and writes "Seen in the State Bank statement."
   - Only after verification does the receipt get generated.
4. **Receipts** tab: Shows issued receipts with numbers like `RCT/2026-27/000001`. Each receipt links back to the verified payment and the bills it paid. Click to view or download the PDF.
5. **My Shift** tab: If you're a cashier, you see your shift: opening cash, money received during the shift, expected closing vs actual count. The variance (₹20 short, etc.) is logged.

**Talking point for the PM:** *"'Said' is not 'seen.' A parent saying they paid ₹4,000 by UPI is a claim. It only becomes real money after someone checks the bank. This protects the school from mistakes and fraud."*

---

## 8 · Late Fees — "Automatic, With a Grace Period"

### What it does
If a bill isn't paid by its due date + grace days, a late fee is added. The school sets the rule once and the system applies it during billing.

### Example Walkthrough

1. In the seed data, the late fee policy is:
   - **Fee head:** Late Fee
   - **Kind:** Fixed amount — ₹100 per bill
   - **Grace days:** 5 (so a bill due Oct 10 becomes overdue on Oct 16)
   - Applied: Once per bill (not per day)
2. Any October bill that wasn't paid by October 15 gets a ₹100 late fee added when November billing runs.
3. The late fee shows up as a separate line on the student's ledger, not as an edit to the original bill.

**Talking point for the PM:** *"The school sets the rule, and the system does it. No one manually adds late fees to 500 students."*

---

## 9 · Adjustments — "Fix a Bill Without Changing It"

### What it does
An issued bill never changes. If there's a mistake or a special case, the system creates a new linked document:
- **Credit note** — reduces what the student owes (e.g., fee waived after a complaint)
- **Debit note** — increases what the student owes (e.g., additional charge)

The system shows the new balance before you save. There is no "edit amount" box anywhere.

### Example Walkthrough

1. Navigate to **Finance → Student Fees → Adjustments** tab.
2. Click **"New Adjustment"**.
3. Select student: **Arjun Kaur**.
4. Select the October bill.
5. Choose **Credit Note**, amount ₹500, reason: "Annual Charges reduced per principal's approval."
6. The system shows: *"Bill was ₹5,500. After this credit note, balance will be ₹5,000."*
7. If the adjustment is above a threshold, it needs approval from a second person before it takes effect.
8. Once saved, the credit note gets its own number (`CN/2026-27/000001`) and its own journal entry in the books.

**Talking point for the PM:** *"We never go back and edit a bill. The original is always there for the auditor. A correction is a new piece of paper that explains itself."*

---

## 10 · Bank Reconciliation — "Match the School's Books to the Bank"

### What it does
The accountant downloads a CSV statement from the bank, uploads it here, and the system tries to match each bank line to a payment the school already knows about. What can't be matched becomes an "exception" for a human to decide.

### Example Walkthrough

1. Navigate to **Finance → Banking**.
2. Select **Fees account (State Bank)** from the dropdown.
3. The statement has already been imported (from the seed data). You see:
   - **Summary:** 5 lines imported, 2 auto-matched, 3 exceptions.
   - **Matched by the system:** 
     - UPI CR FROM PARENT — ₹4,000 → matched to the UPI payment claim (UTR 4821 0000 1111). Reason: "Same reference, same amount."
     - NEFT CR HARJIT SINGH — ₹3,500 → matched to the NEFT collection. Reason: "Reference match."
   - **Exceptions (need a human):**
     - *SMS ALERT CHARGES — ₹11.80 debit* → This is a bank charge. The accountant clicks "Check", picks "Bank charges expense", and matches it.
     - *INTEREST CREDIT — ₹125 credit* → This is interest income. The accountant records it as income.
     - *NEFT CR UNKNOWN SENDER — ₹2,500 credit* → Nobody knows who sent this. The accountant marks it as "unidentified" and investigates.
4. Click **"Match Automatically"** to re-run the matching engine after new payments have been verified.
5. Click **"Show Statement"** to see the **Reconciliation Statement** — a print-ready summary showing why the school's books and the bank differ, broken down by timing differences and unmatched items.

**Talking point for the PM:** *"Every school does bank reconciliation in Excel today. This does it in minutes, and the exceptions are grouped with 'Fix' buttons. The auditor gets a print-ready reconciliation statement."*

---

## 11 · Payroll — "Salaries, From Setup to Payslip"

### What it does
Payroll has seven tabs covering the full salary cycle:

| Tab | What happens |
|---|---|
| **Payroll Runs** | Create and run the monthly payroll |
| **Salary Setup** | Define salary structure (components like Basic, HRA, PF) |
| **Inputs** | Enter working days, leave, overtime for each employee |
| **Advances** | Track salary advances and loan deductions |
| **Payments** | Mark salaries as paid and generate bank files |
| **Payslips** | View and download individual payslips |
| **Reports** | Payroll register, PF/ESI summaries, bank file |

### Example Walkthrough

1. Navigate to **Finance → Payroll**.
2. **Salary Setup** tab:
   - You see the salary structure **"Greenfield 2026-27"** with components:
     - **Basic** — Fixed amount (varies by employee)
     - **HRA** — 40% of Basic
     - **PF (Employee)** — 12% of Basic (deduction)
     - **PF (Employer)** — 12% of Basic (employer cost, not deducted from salary)
     - **ESI (Employee)** — 0.75% of Gross (deduction, if salary under threshold)
     - **Professional Tax** — Slab-based (deduction)
   - The statutory rules (PF, ESI, PT) are marked as "examples — your accountant must approve."
   - Seven Mohali staff have been assigned salaries:

     | Employee | Code | Monthly Basic |
     |---|---|---|
     | Anita Sharma (Principal) | ADM-001 | ₹55,000 |
     | Meera Patel (VP) | FAC-001 | ₹45,000 |
     | Rajesh Kumar | FAC-002 | ₹38,000 |
     | Priya Singh | FAC-003 | ₹35,000 |
     | Sunil Verma | FAC-004 | ₹32,000 |
     | Kavita Rao | STF-001 | ₹28,000 |
     | Rohan Gill | STF-002 | ₹26,000 |

3. **Inputs** tab:
   - Shows each employee and their monthly inputs (working days, paid leave, LOP days).
   - **Kavita Rao (STF-001):** No input entered yet — this is a deliberate exception. The payroll run will flag her.
   - **Rohan Gill (STF-002):** Also missing input.
   - Meera Patel took 1 paid leave day this month.
4. **Payroll Runs** tab:
   - Click **"New Run"** for November 2026.
   - The system shows the **exception queue** — employees who can't be processed:
     - *"Kavita Rao — Days not entered"*
     - *"Rohan Gill — Days not entered"* (or "Bank details missing" for Kavita)
   - For every other employee, it shows the calculated payslip:
     - Anita Sharma: Basic ₹55,000 + HRA ₹22,000 = Gross ₹77,000. PF ₹6,600, ESI ₹577.50 → Net ≈ ₹69,000.
   - Fix the exceptions (enter the days, add bank details), then **Approve** and **Finalize**.
5. **Payslips** tab: After finalizing, each employee's payslip is generated with a number like `PS/2026-27/NOV/001`. It shows every earning, deduction, and the net pay.
6. **Payments** tab: Generate a bank file (CSV with name, account, IFSC, amount) to upload to the bank for salary transfer.

**Talking point for the PM:** *"Payroll shows only the exceptions. If 50 employees are fine and 2 have problems, the accountant sees only those 2. Fix them, approve, finalize, download the bank file."*

---

## 12 · Expenses — "Track What the School Spends"

### What it does
Record school spending (electricity, supplies, maintenance) and track vendor bills. Each expense is categorized and posted to the books automatically.

### Example Walkthrough

1. Navigate to **Finance → Expenses**.
2. **Expenses** tab — you see two expenses from the seed data:
   - **EXP/2026-27/000001** — ₹3,200, Utilities, "Electricity bill", paid from bank, 3 days ago. Status: **Posted** ✓ (no GST, so it went straight to the books).
   - **EXP/2026-27/000002** — ₹5,000 + 18% GST = ₹5,900, Supplies, "Lab bulbs and wiring", vendor: Sharma Electricals, **not paid yet**. Status: **Tax Decision Needed** — the accountant must decide whether to claim the GST paid on this purchase.
3. To add a new expense:
   - Click the expense form at the top.
   - Pick category: "Utilities".
   - Enter amount: ₹4,500.
   - Description: "Water bill".
   - Campus: Mohali (auto-filled).
   - Payment: "Paid from bank" → select State Bank account.
   - GST rate: 0% (water).
   - Submit — it's immediately posted.
4. **Vendors & Bills** tab:
   - **Sharma Electricals** — GSTIN 03ABCDE1234F1Z5, contact: Rakesh Sharma.
   - Open vendor bill: **SE/2026/118** — "Annual electrical maintenance", ₹30,000, due in 25 days.
   - The school can mark vendor bills as paid when the payment goes out.

**Talking point for the PM:** *"Every expense goes to the right account automatically. The accountant picks the category and the system does the double-entry bookkeeping behind the scenes."*

---

## 13 · Tax & GST — "Working Copies, Not Filed Returns"

### What it does
Shows the monthly GST working: outward summary (fees billed), exempt fees, ITC register (tax on purchases), and liability summary. Everything is a working copy — the school's CA files the actual return.

### Example Walkthrough

1. Navigate to **Finance → Tax & GST**.
2. Select month: **November 2026**.
3. **Needs Review** section:
   - Shows *"1 purchase line needs an ITC decision"* — the lab supplies expense with 18% GST.
   - The accountant ticks the line, writes a reason ("Used for school office, not exempt teaching"), and clicks **Claim** or **Don't Claim**.
4. **GST Summaries** — click through the tabs:
   - **Outward Summary** — shows fees billed this month, split by exempt and taxable.
   - **Exempt Fees** — Tuition, Annual, Computer, Exam (all exempt for education).
   - **ITC Register** — the GST paid on the lab supplies purchase.
   - **Liability Summary** — net GST owed (usually very little for a school, since most fees are exempt).
5. Each report has a **Download CSV** button, clearly marked: *"Working copy — not a filed return."*
6. **Record GST Payment** — when the school pays its GST liability, record the challan here.

**Talking point for the PM:** *"The screen does the math. The CA downloads the CSVs, checks them, and files the return. The school never has to build the GST working in a spreadsheet."*

---

## 14 · Accounting & Reports — "The Books"

### What it does
Every rupee that moves — a bill issued, a payment received, a salary paid, an expense recorded — creates a balanced journal entry (debits = credits). This section is the accountant's view of everything.

It has five tabs:

| Tab | What it shows |
|---|---|
| **Journals** | Every entry, with its source (which bill, receipt, or payslip created it) |
| **Ledger** | All entries for one account (e.g., "Tuition Income" or "State Bank") |
| **Trial Balance** | The classic debit/credit summary of all accounts |
| **Close** | Lock a month so its numbers can't change |
| **Reports** | Income & Expenditure, Balance Sheet, Cash Book, Bank Book, and collection reports |

### Example Walkthrough

1. Navigate to **Finance → Accounting & Reports**.
2. **Journals** tab:
   - You see journal entries like:
     - `JRN/2026-27/000045` — Oct 5 — "Bill issued: Arjun Kaur, October 2026" — Debit: Student Receivable ₹5,500, Credit: Tuition Income ₹4,000, Computer Income ₹1,500.
     - `JRN/2026-27/000078` — Oct 20 — "Payment received: UPI ₹4,000" — Debit: State Bank ₹4,000, Credit: Student Receivable ₹4,000.
   - Click any journal to see its lines and the source document.
3. **Ledger** tab:
   - Select account: **Tuition Income (4100)**.
   - See every credit entry — each one from a bill. The running balance grows with each bill issued.
4. **Trial Balance** tab:
   - Shows all accounts, with total debits and credits. The totals at the bottom match (debits = credits).
5. **Close** tab:
   - Shows the months. To close October:
     - The system checks: *"Are all October payments verified? Any unmatched bank lines? Any pending approvals?"*
     - **Must fix** items block closing. **Can accept** items need a note.
     - Closing needs a second person (the Approver).
   - Once closed, October is locked — no new entries can go into it.
6. **Reports** tab:
   - Pick **"Income & Expenditure"** — shows total income vs total expenses for a date range.
   - Pick **"Money received by method"** — shows how much came in by Cash, UPI, NEFT, Cheque.
   - Pick **"Money received by class"** — shows Class VIII paid ₹1,50,000, Class VI paid ₹80,000, etc.
   - Every report has a **Download CSV** button.

**Talking point for the PM:** *"Every bill, every payment, every salary automatically creates the accounting entry. The accountant doesn't do double-entry by hand. The system does it, and the accountant reviews the trial balance."*

---

## 15 · Needs Attention — "The Exception Hub"

### What it does
One page that collects everything across Finance that needs a human. Each item has a "Fix" button that takes you directly to the right screen.

### Example Walkthrough

1. Navigate to **Finance → Needs Attention** (or click the yellow banner on the Overview).
2. Items are grouped by category:
   - **Payments waiting for verification** — 2 items (the UPI claim and the NEFT payment)
   - **Bank lines not matched** — 3 items (SMS charge, interest, unknown sender)
   - **Billing exceptions** — students with plan conflicts or missing tax codes
   - **Payroll exceptions** — employees with missing inputs or bank details
   - **Tax decisions needed** — the lab supplies ITC decision
3. Click **Fix** on any item — it opens the exact screen where you resolve it.
4. As items are fixed, they disappear from this page. When everything is done, it shows: *"Nothing needs attention. Everything in Finance is up to date."* ✓

**Talking point for the PM:** *"This is the accountant's to-do list. They don't have to check six different screens. Everything that needs a person is here, with a one-click fix."*

---

## 16 · Parent Portal (Fees View) — "What Does the Parent See?"

### What it does
Parents log in and see only their children's fee information: bills, payments, outstanding amounts, and receipts. They cannot see other students' data or any internal finance settings.

### Example Walkthrough

1. Log in as the demo parent (`parent@greenfield.demo`).
2. The parent sees their children: **Arjun Kaur** (Class VIII) and **Riya Kaur** (Class VI).
3. For each child, they see:
   - The outstanding amount
   - Each bill with its due date and status (paid / partially paid / unpaid)
   - Payment history — with receipt numbers
   - The concession applied (Riya has the sibling discount)
4. The parent **cannot** see internal details like bank accounts, approval requests, payroll, or other students' accounts.
5. If a parent paid by UPI, they can report it ("I paid ₹4,000, here's the UTR") — this creates a **claim** that the school verifies.

**Talking point for the PM:** *"The parent sees exactly what the front office sees for their child — no more, no less. They can check their bill at midnight without calling the school."*

---

## 17 · Approval Workflow — "The Second Pair of Eyes"

### What it does
Certain actions need a second person to approve:
- Large credit notes
- Period closing
- Bank detail changes
- Salary structure changes
- Expenses above a threshold
- Manual journal entries

The requester and the approver must be different people.

### Example Walkthrough

1. Navigate to **Finance → Settings → Approvals**.
2. You see the approval policies:
   - Credit notes above ₹5,000 need approval.
   - Period close always needs approval.
   - Manual journal entries need approval.
3. The Approver (`approver@greenfield.demo`, who is the Principal, Anita Sharma) sees pending requests on this tab.
4. For example, when the accountant closes October:
   - The system creates an approval request: *"Close October 2026. All checks passed."*
   - The Principal reviews it and clicks **Approve**.
   - Now October is closed.
5. The approval, the reason, and both people's identities are logged in the finance audit trail.

**Talking point for the PM:** *"The person doing the work is not the person approving it. This is basic financial control, and it's built into the system — not a workaround."*

---

## 18 · Audit Trail — "Who Did What, When"

### What it does
Every action in Finance — creating a bill, verifying a payment, changing a tax code, closing a month — is logged with who did it, when, and what changed. No secrets (like bank account numbers) are stored in the audit log.

### Example Walkthrough

1. Every screen in Finance shows audit information:
   - Bills show "Issued by [name] on [date]"
   - Payments show "Verified by [name] on [date]"
   - Approvals show "Approved by [name] on [date], reason: [text]"
2. The audit log captures before-and-after snapshots:
   - *"Tax code EXEMPT_EDU changed: rateBps was 0, is now 0 (no change). Name was 'Education Exempt', changed to 'Education Exempt — confirmed by CA'."*
3. Sensitive data (full bank account numbers) is never stored in audit logs — only the last 4 digits.

**Talking point for the PM:** *"If the auditor asks 'who changed this fee plan?' or 'who approved this refund?', the answer is one click away. Everything is traceable."*

---

## Demo Flow — Recommended Order for a PM Presentation

> Walk through these screens in this order for a 30-45 minute demo. Each step naturally leads to the next.

| Step | Screen | What to show | Time |
|---|---|---|---|
| 1 | Finance Overview | The three tiles, the pulse, the attention banner | 3 min |
| 2 | Finance Settings | Checklist (all done), School & Tax, one bank account, one approval rule | 5 min |
| 3 | Fee Plans | Class VIII plan with 7 line items, explain frequency and proration | 4 min |
| 4 | Concessions | Sibling concession auto-detected for Riya Kaur | 3 min |
| 5 | Billing | October (issued) vs November (checked with exceptions) | 5 min |
| 6 | Student Account | Arjun Kaur's ledger — bill, payment, balance | 4 min |
| 7 | Collect Payments | Take a payment, show verification queue, show a receipt | 5 min |
| 8 | Bank Reconciliation | The imported statement, 2 auto-matched, 3 exceptions | 5 min |
| 9 | Payroll | Salary setup, the exception queue (Kavita & Rohan), payslip preview | 5 min |
| 10 | Expenses | Two expenses, the GST/ITC decision on the supplies purchase | 3 min |
| 11 | Accounting | One journal, the trial balance, period close | 4 min |
| 12 | Needs Attention | Everything in one place, show a "Fix" click | 2 min |

---

## Key Talking Points Summary

| Theme | One-liner |
|---|---|
| **Automation** | The system does the routine; people handle the exceptions |
| **Auditability** | Every rupee has a trail — who, when, why |
| **Safety** | Bills never change, receipts never repeat, money is verified before it counts |
| **Simplicity** | The front office staff sees plain English, not accounting jargon |
| **Control** | Sensitive actions need a second person; permissions are checked on the server |
| **Privacy** | Bank numbers are hidden; salary is private; parents see only their children |
| **Accuracy** | Balances are calculated, never typed; debits always equal credits |

---

> **Note:** All amounts, names, and data in this walkthrough match the seed data from `npm run seed` for Greenfield Public School, Mohali campus, session 2026-27. To reset the demo, run the seed again.
