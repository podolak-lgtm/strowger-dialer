# State telemarketing rules for a predictive dialer: summary (as of 7 Nov 2026)

This is research, not legal advice. 6 states were checked against official statute or bill text: OR, PA, FL, MD, WA, SC. The rest come from secondary sources. The main one is Trellus's per-state pages, last reviewed 29 Oct 2026, cross-checked against the Convoso (Apr 2024) and ClickPoint (Oct 2026) charts. Each entry in `state-rules.json` has a `verified` field.

## Federal baseline
- **Calling hours.** TSR 16 CFR 310.4(c) and TCPA 47 CFR 64.1200(c)(1) allow 8am-9pm in the called party's local time.
  - The TCPA hours rule covers "telephone solicitations". That definition excludes calls made with prior express invitation or permission, and calls to established-business-relationship (EBR) customers.
  - Since 2025, class actions have claimed that marketing texts sent outside 8am-9pm break this rule, even when the consumer consented. The Ecommerce Innovation Alliance (EIA) asked the FCC to rule on this (petition of Mar 2025, DA 25-216). **I found no FCC ruling.** Apply quiet hours to texts.
- **Consent revocation.**
  - Since Apr 11 2025, consumers can revoke consent by any reasonable means, and you must honor it within 10 business days (64.1200(a)(10)).
  - **FCC 26-67** (adopted Sep 30 2026; published at 91 FR 67214 on Oct 26 2026; in force about **Nov 25 2026**) changes this:
    - A caller may designate exclusive opt-out methods: an IVR or key-press on calls, standard reply words on texts, or a website or phone number. The method must be clearly disclosed, and every standard stop word still works.
    - The 10-business-day window stays.
    - An opt-out from one informational category covers only that category. An opt-out from marketing covers all of the caller's marketing.
  - The original "revoke-all" provision was delayed to Jan 31 2027 (DA 26-12) and is now largely superseded.
  - The FCC's further notice (FNPRM) asks whether to shorten the window to 7 business days. Build the window as a configurable value.
- **Other federal points.** The 11th Circuit vacated the one-to-one consent rule (*IMC v. FCC*, Jan 2025). The rule requiring prior express written consent (PEWC) for autodialed or prerecorded telemarketing to cell phones still applies. There is no federal per-day cap on attempts.

## Corrections to the existing matrix
| State | Matrix said | Finding |
|---|---|---|
| **PA** | 8-21 | **Act 47 of 2026, in force about Oct 18 2026:** 9am-7pm, **no Sundays, no legal holidays**. Texts, voicemail and ringless voicemail are now covered, with STOP keywords. Saturday afternoon is a statutory half-holiday, so it is an open question (see below). The JSON uses Saturday 9-12 to be conservative. |
| **WA** | max 3 | **No cap.** RCW 80.36.390 sets 8-20 and a 1-year do-not-call honor period. Texts are covered by CEMA (RCW 19.190.060), not by this cap. |
| **CT** | max 3 | **No cap found.** Hours 9-20 are correct. CT requires PEWC for *every* telephonic sales call, texts included. |
| **NJ** | 8-20, max 3 | **8-21** (no unsolicited calls 9pm-8am) and **no cap**. Registration is required. |
| **MS** | 8-21 | **8-20** under 77-3-723 (77-3-707 is the wrong cite). No Sundays. The holiday ban was **repealed** in 2023-24. |
| **NV** | 8-21 | Most likely **9-20** (NRS 598.0918, 597.814), but one source says 8-21. Unverified. |
| **ND** | 9-21 | **8-21** (51-28-05). Same as federal. |
| **UT** | 8-21 | Hours are right, but the matrix **missed the Sunday and legal-holiday ban**. This only applies when there is no prior express consent. |
| **AL** | 8-20 | Same hours, and **no Sundays or holidays** (PSC rule 770-X-5-.17). The 8-19A-14 cite is the wrong source. |
| **FL** | 8-20, max 3 (501.059) | Numbers are right, but the source is **501.616(6)**. The FTSA (501.059) carries the autodialer consent rule and the 15-day text cure period, not the hours or the cap. |
| **MD** | §14-4601 | The correct cite is **Com. Law 14-4502(c)**. |
| **SC** | §16-17-446 | The correct cite is **37-21-30**. Texts are explicitly covered. No Sunday ban. |
| **OK** | — | Confirmed. Precise cite: 775C.4(A). |
| **TX, RI, LA, NY, KY, IN** | — | Hours confirmed. **NY** has an emergency ban and registration. **IN** limits ADAD calls to 9-20. **RI** adds a holiday list. **TX** now treats texts as telephone solicitations (SB 140). |

## States added to the matrix
- **OR**, new since Jan 1 2026 (HB 3865, verified against the enrolled text):
  - 8am-8pm.
  - **No more than 3 solicitations per party per 24h, any subject. Calls and texts both count.**
  - Both the hours and the cap are waived where there is an EBR (a transaction in the last 18 months).
- **9am-9pm:** MI, MN, NM.
- **8am-8pm:** MA, WY.
- **IL:** 8-21 for live calls; 9-21 for prerecorded autodialer calls.
- **ME:** an automated calling device may make at most 1 call per number per 8 hours. One source also limits these devices to weekdays 9-5.
- **NE and CA:** prerecorded or ADAD calls only. NE allows these from 1pm on Sundays and holidays. CA bars them 9pm-9am.
- **SD:** sources conflict. Vendor charts say no calls on Sunday, 9-21. Trellus says that rule applies only to autodialed prerecorded calls.
- **VA:** SB 1339, effective Jan 1 2026. Texts are covered, and STOP requests must be honored for 10 years.
- **TN:** cap of 10,000 prerecorded calls per month, starting Oct 1 2026.
- Registration requirements are listed for each state in the JSON.

## Strictest states
- **PA:** 9-7, no Sundays or holidays, possibly no Saturday afternoons.
- **RI:** weekdays 9-6, Saturday 10-5, no Sundays or holidays.
- **CT:** 9-8, and PEWC for every sales call or text.
- **TX:** 9-9, and noon-9 on Sundays.
- **LA, AL, UT:** no Sundays and no holidays. **MS:** no Sundays.
- **8pm cutoff:** FL, OK, MD, WA, OR, MA, WY, LA, AL, MS, CT.
- **KY:** starts at 10am.
- **Emergency bans:** LA and NY only. I found none in other states.

## Attempt caps, and whether texts count
- **OR:** 3 per 24h, any subject. **Texts count explicitly.** Waived where there is an EBR.
- **MD:** 3 per 24h, same subject. The statute doesn't mention texts, but secondary sources say calls and texts both count.
- **OK:** 3 per 24h, same subject. Texts very likely count, because the consent definition names text messages.
- **FL:** 3 per 24h, same subject, any number. The statute says "phone calls", so whether texts count is unsettled. Count them to be safe.
- **ME:** 1 per 8 hours, automated devices only.
- **WA, CT, NJ:** no cap.

**States where texts are explicitly inside hours or telemarketing rules:** OR, PA, SC, VA, TN, CT, TX (for registration), NY, FL (FTSA), MD and OK (consent), plus the do-not-call lists in IN, AZ, MO, CO, WI and NC.

## Questions for a lawyer
1. **PA:** do Saturday afternoon half-holidays (44 P.S. 11) count as "legal holidays" under Act 47? Is the effective date Oct 18 or Oct 19?
2. **FL, MD, OK:** does a text count toward the 3-per-24h cap? How should "same subject matter" be defined for campaign tagging?
3. Do the TCPA quiet hours apply to texts the consumer consented to? The EIA petition is still pending.
4. **NV, SD, ND, KS, ME:** the exact hours. I couldn't retrieve the statute text, and sources conflict.
5. **TX:** do the 301.051 hours apply to texts? What does the Nov 2025 settlement exempting consented texts from registration actually cover?
6. **LA:** which day-by-day holidays does the PSC list (Acadian Day, Inauguration Day, Juneteenth, New Year's Eve)? Does "telephonic solicitation" cover texts?
7. **WA:** after ESHB 2274 (2026), what are the CEMA consent and damages rules for texts?
8. Does a predictive dialer that bridges to a live agent count as an "automated system" or ADAD under the FL, MD, OK, IN, ME, IL and NE rules? Several of these rules key on the dialing system or on prerecorded messages.
9. **Registration:** which states apply to the tenant's business model? Many registration statutes only reach specific kinds of offer, and fees and bonds differ between sources. Confirm with each agency.
10. **Location:** for cell numbers, can we rely on the area code (OR allows this explicitly) or must we use the actual location? Recommend enforcing the stricter of the two.

Main sources: the official texts (Oregon's legislature site, the PA General Assembly, flsenate.gov, mgaleg.maryland.gov, the RCW site, scstatehouse.gov); trellus.ai/calling-laws/<state>; the Convoso state guide (Apr 2024); the ClickPoint chart (Oct 2026); Kelley Drye and TSI on FCC 26-67; and Paul Hastings and NatLawReview on Texas SB 140.
