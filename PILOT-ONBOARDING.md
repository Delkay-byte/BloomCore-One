# BIK Prestige Enterprise — Pilot Onboarding Guide

**Purpose:** Help new users get started with the platform quickly and confidently.

---

## How Everyone Logs In (Unified Login)

All non-admin users now share **one** login page. You no longer need to remember
separate role-specific URLs.

- **Canonical login page:** `/login`
- **Administrator login (separate):** `/admin/login`

### The standard instruction

> **Go to the BIK Prestige login page and select who you are.**

| User type          | Choose on the login screen |
| ------------------ | -------------------------- |
| Customer           | 👤 **Customer**            |
| MoMo Agent         | 💰 **MoMo Agent**          |
| Susu Collector     | 🧑‍💼 **Susu Collector**    |
| Administrator      | Use the **separate administrator login** |

1. Open the BIK Prestige login page (`/login`).
2. Tap/click the card that matches **who you are**.
3. Enter your credentials in the form that appears.
4. You will land in your own dashboard.

> The role you select is only a *requested workspace*. The server checks it
> against your actual account capabilities, so a customer can never open a
> staff dashboard (and vice versa). If you pick a role you are not authorized
> for, sign-in is denied.

Legacy shortcuts still work and simply pre-select the role for you:
`/customer/login` → `/login?role=customer`,
`/login?role=momo` (MoMo Agent), `/login?role=susu` (Susu Collector).

### Friendly short links (preferred for sharing)

Send each person the matching short link — they are easy to type, print,
WhatsApp, or encode into a future QR code:

| User           | Give them                      |
| -------------- | ------------------------------ |
| Customer       | `/login/customer`              |
| MoMo Agent     | `/login/momo`                  |
| Susu Collector | `/login/susu`                  |
| Administrator  | `/admin/login`                 |

There is also a public **Access Guide** at `/access` that lists all four
options with copy-link buttons. Do **not** send `/login/admin` — admin always
uses the separate `/admin/login`.

### Customer Portal handout (future-ready)

For printed onboarding cards and posters, include only the public link — never
credentials or recovery information:

> **Customer Portal**
> Scan or visit the Customer Login link to view your savings.
> `https://bik-prestige-enterprise-pcxi.onrender.com/login/customer`

---

## For the Admin (Owner)

### Logging In
1. Open the **administrator login**: `/admin/login`
2. Enter your email and password (provided privately)
3. You will see the **Platform Dashboard**

> The admin login is kept separate from the shared `/login` page for security.
> Do **not** use the shared page for administrator access.

### Your Dashboard
The dashboard shows everything at a glance:
- **MoMo Module:** Active locations, workers, submitted reports, discrepancies
- **Susu Module:** Active customers, collectors, today's collections, outstanding
- **Financial Summary:** Cash positions, commissions, pending remittances

### Creating a Location
1. Go to **MoMo → Locations** in the sidebar
2. Click **+ Add Location**
3. Enter the location name, code, address, and phone
4. Click **Create Location**

### Creating a Worker
1. Go to **MoMo → Workers** in the sidebar
2. Click **+ Add Worker**
3. Enter the worker's full name, email, phone, and a temporary password
4. Select their assigned location
5. Click **Create Worker**
6. Share the credentials privately with the worker

### Creating a Collector
1. Go to **Susu → Collectors** in the sidebar
2. Click **+ New Collector**
3. Enter the collector's name, email, phone, and temporary password
4. Click **Create Collector**

### Assigning Customers to Collectors
1. Go to **Susu → Customers**
2. Find the customer and click **Assign** next to their name
3. Select the collector

### Reviewing Reports
- **MoMo Reports:** Go to **MoMo → Reports** — filter by location, status, or date
- **Susu Reports:** Go to **Susu → Reports** — view contributions and withdrawals
- **Audit Log:** Go to **Administration → Audit Log** — see all system activity

### Monitoring Activity
From the dashboard, you can see without calling anyone:
- Which MoMo locations have submitted today
- Which locations are pending
- Any discrepancies (non-zero variance)
- Susu collections made today
- Outstanding customers who haven't paid
- Collector remittance status

### Logging Out
Click **Sign Out** at the bottom of the sidebar.

---

## For the MoMo Worker

### Logging In
1. Open the BIK Prestige login page: `/login`
2. Tap **💰 MoMo Agent**
3. Enter your email (or phone) and password
4. You will see your **Worker Dashboard**

### Your Dashboard
- You see a greeting and your assigned location name
- If today's account is not yet opened, you can start one

### Opening Today's Account
1. Click **Start Daily Account** on your dashboard
2. You will go through 5 steps:

#### Step 1: Opening Balances
- Enter your **Opening MoMo Float** (money in your MoMo account at start of day)
- Enter your **Opening Cash** (physical cash at start of day)
- Click **Next**

#### Step 2: Daily Totals
- **Cash-In / Deposits:** Total money customers deposited into MoMo
- **Cash-Out / Withdrawals:** Total money customers withdrew from MoMo
- **Cash Received:** Physical cash you received from customers
- **Cash Paid:** Physical cash you paid out to customers
- **Commission:** MoMo commission you earned today
- **Other Income:** Any other income
- Click **Next**

#### Step 3: Expenses
- Click **+ Add Expense** to add each expense
- Enter the description (e.g., "Transport", "Airtime") and amount
- Remove any mistakes with the ✕ button
- Click **Next**

#### Step 4: Closing Balances
- Enter your **Closing MoMo Float** (money in MoMo at end of day)
- Enter your **Closing Cash** (physical cash at end of day)
- Click **Next**

#### Step 5: Review
- Check your reconciliation summary
- Green means balanced — Red means discrepancy
- You can **Save Draft** to continue later, or **Submit Account** when ready

### Saving a Draft
Click **Save Draft** at any time. You can return later to finish.

### Submitting
Click **Submit Account** when all figures are correct. After submission, the report is read-only.

### Logging Out
Tap the menu (☰) → **Sign Out**

---

## For the Susu Collector

### Logging In
1. Open the BIK Prestige login page on your **phone**: `/login`
2. Tap **🧑‍💼 Susu Collector**
3. Enter your email (or phone) and password
4. You will see your **Collector Dashboard**

### Your Dashboard
- **Collected Today:** Total money collected today
- **Assigned Customers:** How many customers are assigned to you

### Today's Route
You will see a list of customers who owe money today:
- Customer name and ID
- How many days are outstanding
- Expected amount to collect
- Daily contribution rate

### Recording a Collection
1. Tap **💵 Record Collection** next to a customer
2. The expected amount is pre-filled
3. Add a note if needed (optional)
4. Tap **✅ Record**
5. You will see confirmation: "Recorded: GH₵X.XX — Y day(s) covered"

### If All Customers Have Paid
You will see: "All caught up! No outstanding collections for today."

### Checking Recent Remittances
Your recent remittances (money you brought to the office) are shown at the bottom of the dashboard.

### Logging Out
Tap the menu (☰) → **Sign Out**

---

## For the Customer

### Logging In
1. Open the BIK Prestige login page: `/login`
2. Tap **👤 Customer**
3. Enter your **Customer ID, phone or email** and password
4. You will see your **Customer Dashboard**

> You do **not** need a Gmail or smartphone email to sign in. A **Customer ID +
> Password** works from any internet-connected device.

### Your Dashboard
- **Savings:** Your Susu savings balance and account status
- **Payments:** Office and agent payments made on your behalf
- **Withdrawals:** Withdrawal requests and history
- **Statement:** Your full savings statement
- **Cycle History:** Past and current savings cycles
- **Profile & Settings:** Update details and change your password

### Logging Out
Tap the menu (☰) → **Sign Out**

---

## Important Notes

### For Everyone
- **Each person has their own login** — do not share accounts
- **Change your password** after first login (Settings → Change Password)
- **Your activity is logged** — the system tracks who did what and when
- **Contact your administrator** if you forget your password or have issues

### For Admin
- **Do not create generic accounts** for multiple people
- **Communicate credentials privately** — never in shared documents
- **Review the audit log** regularly for unusual activity
- **Back up the database** at the end of each day

### For Workers
- **Save your draft** if you need to step away
- **Double-check your closing balances** before submitting
- **Record all expenses** — this helps with reconciliation

### For Collectors
- **Use your phone** — the interface is designed for mobile
- **Record collections immediately** after receiving money
- **Add notes** if something unusual happens

---

*Built by BloomCore Technologies for BIK Prestige Enterprise*
