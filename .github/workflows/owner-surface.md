# boardroom.asisaga.com · Owner surface (`boardroom/0.4`)

Repository: **boardroom.asisaga.com**. Read `https://github.com/ASISaga/boardroom/.github/specs/00-DECISIONS-AND-MAP.md` and boardroom `relay-and-endpoints.md` first.

This file defines what the owner sees and does on the Boardroom page: the board's sittings, each CXO's desk and word, what is waiting and can be vetoed, questions to answer, messages to send, whether the board is working or waiting, the company's purpose and path, and the editor for the company's delegation of power. Operators also get a prompt view that owners never see.

Binding decisions: D-13, D-17, D-18, D-20, D-21, D-25, D-26. Invariants: INV-9, INV-16.

---

## 1. Principles

| Req | Requirement |
|---|---|
| WEB-1 | The owner sees what the CXOs say and do, and what Python decided, never what the models were sent (INV-16). |
| WEB-2 | Every state is shown in words; every time in the company's time zone; every amount with its currency. |
| WEB-3 | Every view works on narrow screens and by keyboard, with visible focus and sufficient contrast. |

---

## 2. Views

| View | Shows | Owner can |
|---|---|---|
| **Board** | The active item: question, sponsor, reason, who is in the room (the voters), the stage and pass, each turn's speech, the motion as spoken and its seconder, the votes, the result and the minutes; queued items in order; past decisions | Read; follow the speech as it arrives |
| **Desks** | Per seat: desk turns with topic, speech and moves in owner wording, and each move's state | Read |
| **Word** | Per seat: measured commitments with status, due date and progression; inquiries with the question, days since engaged and how their facts moved; tasks under each with assignee and state | Read |
| **Waiting** | Actions scheduled with their window end; awaiting approval with deciders; held with reason | Veto inside the window, with a reason |
| **Questions** | Requests addressed to the owner, with the asking CXO's speech | Answer |
| **Messages** | Owner messages and where they went | Write to a seat or to the board |
| **Work** | Turns waiting and their positions, estimated waits, turns that could not be completed and why | Read |
| **Company** | Purpose, path with each stage's distance and its history (progress records), products | Edit purpose, path and products (with reason) |
| **Delegation of power** | Departments, heads, matters, partners, limits, always-board matters, veto and call-in windows, vote rules; the effect policy | Edit with preview and reason; view history (§3) |
| **Prompt view** (operators only) | For any call: the messages sent and the reply | Read |

---

## 3. Editing the delegation of power

| Req | Requirement |
|---|---|
| WEB-4 | The editor shows the table in words (for example "Finance, headed by the CFO, may spend up to 500 USD alone; up to 5,000 USD with the founder; above that, the board decides"). |
| WEB-5 | Before saving, the owner sees the preview: for each seat and matter, what it may decide alone, with whom, and what goes to the board (boardroom `relay-and-endpoints.md` §5). |
| WEB-6 | Saving requires a reason. A conflict (someone else saved first) shows both versions and lets the owner start again from the newer one. |
| WEB-7 | History shows each version, who saved it, when, why, and what changed. |
| WEB-8 | The same rules apply to the effect policy, purpose, path and products. |

---

## 4. The prompt view

| Req | Requirement |
|---|---|
| WEB-9 | The prompt view is rendered only for the Operator role, loaded only on demand from the operator endpoint, and never included in the owner's page data or bundle state (INV-16). |

---

## 5. Tests

| Req | Requirement |
|---|---|
| WEB-10 | Each view has tests on narrow and wide screens and by keyboard, and screenshots in the pull request. |
| WEB-11 | A test asserts that no owner page response contains prompt text: none of the stored instruction texts, and no rendered reflection (m1) from the staging golden renders. |

---

## 6. Vectors

| ID | Given | Expected |
|---|---|---|
| V-WEB-1 | A sitting at pass 2 with the CMO speaking | Board view: stage discussion, pass 2, the CMO as current speaker, voters listed, speech streaming |
| V-WEB-2 | An action scheduled with 40 minutes left in its window | Waiting view: the window end and a veto control |
| V-WEB-3 | A turn failed after its restarts | Work view: the seat, the topic and the cause in words |
| V-WEB-4 | Owner edits the CFO's spend limit and opens the preview | The CFO's levels at each amount before and after |
| V-WEB-5 | Owner account requests the prompt view | Not rendered; the endpoint refuses |
