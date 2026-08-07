/**
 * The two source documents for the saved example run, and the questions asked
 * of them.
 *
 * HALVERD INSTRUMENTS DOES NOT EXIST. The name, the products, the customers and
 * every figure below were invented for this demonstration. Nothing here imitates
 * a real company's filings, and both documents say so on their own first page so
 * that the disclaimer travels with the text into retrieval.
 *
 * The pair is the point. A single quarterly report answers nothing interesting;
 * two consecutive ones do, because the later report resolves one thing the
 * earlier one flagged and contradicts another:
 *
 *   resolved     Q2 has the PT-40 second source "identified and sampled but not
 *                qualified"; Q3 has it qualified on 14 May 2026.
 *   contradicted Q2 records a $2.4m HX-9 warranty accrual and says it is
 *                sufficient; Q3 says it is not, and raises it to $6.1m.
 *
 * Neither fact can be answered from one document. That is what the example is
 * there to show.
 *
 * Pages are written as arrays of lines because that is what the PDF writer takes.
 * Keep each page's text under 1600 characters once whitespace is collapsed:
 * `chunkPages` splits at that width, so a page under it becomes exactly one
 * chunk and every citation then names a real page rather than a fragment index.
 */

/** Printed on page 1 of both documents, so it is in the retrievable text and not
 *  only in the interface. */
const FICTION_NOTICE =
  'Halverd Instruments is a fictional company. This document was written to demonstrate ' +
  'retrieval software and describes no real business, product, person or transaction.'

export const NOTEBOOK_TITLE = 'Halverd Instruments — FY2026 quarters'

export const SOURCE_DOCUMENTS = [
  {
    name: 'Halverd Q2 FY2026 quarterly report.pdf',
    pages: [
      [
        'HALVERD INSTRUMENTS, INC.',
        'Quarterly Report — Second Quarter, Fiscal Year 2026',
        'Quarter ended 30 April 2026. Reported 21 May 2026.',
        '',
        'SUMMARY',
        '',
        'Revenue for the second quarter was $31.2 million, an increase of 8 percent against the',
        '$28.9 million reported in the second quarter of fiscal 2025. Gross margin was 58.4',
        'percent, down 110 basis points year over year, reflecting expedited freight on PT-40 die',
        'shipments and the initial cost of the HX-9 firmware remediation programme. Operating',
        'income was $4.1 million. Net income was $3.3 million, or $0.19 per diluted share.',
        '',
        'We are reaffirming full-year fiscal 2026 revenue guidance of $118 million to $124 million',
        'and full-year gross margin guidance of 58 to 60 percent.',
        '',
        'Two matters dominate this report and are discussed in full below: the HX-9 depth drift',
        'defect, for which we have recorded a warranty accrual this quarter, and the single-source',
        'position on the PT-40 pressure transducer die.',
        '',
        FICTION_NOTICE,
      ],
      [
        'SEGMENT RESULTS',
        '',
        'Subsea Sensing revenue was $19.4 million, up 11 percent year over year, carried by the',
        'HX-9 and HX-11 depth and conductivity instruments and by a full quarter of the Vessel',
        'Integration Kit introduced in the first quarter.',
        '',
        'Industrial Calibration revenue was $11.8 million, up 3 percent year over year. Growth here',
        'remains slower than the segment plan we set in November, and we now expect Industrial',
        'Calibration to finish the year at the low end of its range.',
        '',
        'Backlog at quarter end was $46.7 million, of which $29.3 million is scheduled to ship in',
        'fiscal 2026.',
        '',
        'CUSTOMER CONCENTRATION',
        '',
        'Trondsen Offshore AS accounted for 41 percent of second-quarter revenue, up from 34',
        'percent in the second quarter of fiscal 2025. Trondsen operates four survey vessels and',
        'has standardised on the HX-9 for depth reference. No other customer accounted for more',
        'than 9 percent of revenue in the quarter.',
        '',
        'We regard this concentration as our single largest commercial risk. A deferral or',
        'cancellation by Trondsen would have a material effect on quarterly revenue and on the',
        'full-year range given above.',
      ],
      [
        'HX-9 DEPTH DRIFT — DESCRIPTION AND PROVISION',
        '',
        'In March 2026 a customer reported that HX-9 units held at depth for extended periods',
        'returned depth values that drifted upward over time. Our engineering review confirmed the',
        'behaviour and traced it to an accumulator overflow in the pressure-compensation routine of',
        'firmware releases 4.2.0 through 4.4.1. Affected units drift by up to 1.8 metres after',
        'approximately 900 hours of continuous submersion. The drift is gradual and does not',
        "trigger the instrument's own fault flag, which is why it was not caught in qualification.",
        '',
        'A corrected firmware release, 4.4.2, entered controlled release on 6 May 2026. Units in',
        'the field can be updated over the vessel link; units in inventory are being updated before',
        'shipment.',
        '',
        'We estimate the affected population at 3,100 units, being all HX-9 instruments shipped',
        'with firmware 4.2.0 or later between June 2024 and April 2026. We have recorded a warranty',
        'accrual of $2.4 million in the second quarter, covering firmware deployment, field',
        'engineering time and the replacement of units that cannot be updated remotely.',
        '',
        'Management believes this accrual reflects our current best estimate and is sufficient to',
        'cover the affected population. No recall is planned.',
      ],
      [
        'SUPPLY — PT-40 PRESSURE TRANSDUCER DIE',
        '',
        'Every instrument in the Subsea Sensing segment depends on the PT-40 pressure transducer',
        'die. The PT-40 is supplied to us by a single vendor, Tessin Micro Fabrication Ltd, under a',
        'supply agreement that expires on 31 January 2027. Tessin manufactures the die on a legacy',
        '150 millimetre line at one site. We hold approximately eleven weeks of PT-40 inventory.',
        '',
        'An interruption at that site, or a failure to renew the agreement on acceptable terms,',
        'would stop production of every Subsea Sensing product within one quarter. We consider this',
        'the most serious operational risk carried by the business.',
        '',
        'We have identified a second source, Kaldbakur Semiconductor hf, and received first samples',
        'in February 2026. Electrical characterisation of those samples is complete and within',
        'specification. Qualification is not finished: the samples have not yet passed the',
        '1,000-hour pressure-cycling test or the salt-fog corrosion test, and we have not yet run a',
        'production lot. Kaldbakur is therefore identified and sampled but not qualified, and no',
        'Kaldbakur die is in any shipped product.',
        '',
        'We are targeting completion of qualification during the third quarter of fiscal 2026.',
        'Until it completes, the single-source exposure described above is unmitigated.',
      ],
      [
        'LIQUIDITY, CAPITAL AND OUTLOOK',
        '',
        'Cash and cash equivalents were $44.6 million at 30 April 2026, against $41.9 million at',
        'the end of the first quarter. The company carries no debt. Capital expenditure in the',
        'quarter was $1.8 million, principally the pressure-cycling chamber installed at the',
        'Aberdeen test facility.',
        '',
        'Operating cash flow was $5.2 million. Days sales outstanding were 61, unchanged from the',
        'prior quarter.',
        '',
        'FULL-YEAR GUIDANCE',
        '',
        'We are reaffirming revenue guidance of $118 million to $124 million for fiscal 2026. The',
        'guidance assumes that HX-9 firmware remediation is completed within the $2.4 million',
        'accrued, that Trondsen Offshore takes delivery on the schedule in the current backlog, and',
        'that PT-40 supply is uninterrupted.',
        '',
        'The board has not authorised a dividend or a repurchase programme for fiscal 2026.',
        '',
        'This report contains forward-looking statements about a company that does not exist.',
      ],
    ],
  },
  {
    name: 'Halverd Q3 FY2026 quarterly report.pdf',
    pages: [
      [
        'HALVERD INSTRUMENTS, INC.',
        'Quarterly Report — Third Quarter, Fiscal Year 2026',
        'Quarter ended 31 July 2026. Reported 20 August 2026.',
        '',
        'SUMMARY',
        '',
        'Revenue for the third quarter was $24.9 million, a decrease of 14 percent against the',
        '$29.0 million reported in the third quarter of fiscal 2025. Gross margin was 51.2 percent.',
        'Operating loss was $2.6 million. Net loss was $2.1 million, or $0.12 per diluted share.',
        '',
        'We are reducing full-year fiscal 2026 revenue guidance to $104 million to $109 million,',
        'from the $118 million to $124 million range reaffirmed in our second-quarter report.',
        'Full-year gross margin guidance is reduced to 53 to 55 percent.',
        '',
        'The reduction has two causes, both discussed below. The HX-9 depth drift defect is',
        'materially larger than we estimated in the second quarter and now requires a partial',
        'recall. Trondsen Offshore has deferred two survey programmes pending completion of that',
        'work.',
        '',
        'One matter has resolved favourably: the second source for the PT-40 pressure transducer',
        'die completed qualification during the quarter.',
        '',
        FICTION_NOTICE,
      ],
      [
        'SEGMENT RESULTS',
        '',
        'Subsea Sensing revenue was $13.1 million, down 31 percent year over year. The decline is',
        'attributable almost entirely to deferred HX-9 and Vessel Integration Kit shipments to',
        'Trondsen Offshore.',
        '',
        'Industrial Calibration revenue was $11.8 million, flat against the prior quarter and up 1',
        'percent year over year. The segment will finish fiscal 2026 below the range set in',
        'November, as indicated in the second-quarter report.',
        '',
        'Backlog at quarter end was $51.4 million. Backlog rose while revenue fell because deferred',
        'Trondsen orders remain in backlog rather than being cancelled.',
        '',
        'CUSTOMER CONCENTRATION',
        '',
        'Trondsen Offshore AS accounted for 29 percent of third-quarter revenue, down from 41',
        'percent in the second quarter. The change reflects lower absolute shipments to Trondsen',
        'rather than growth elsewhere. On 11 June 2026 Trondsen deferred two survey programmes,',
        'together representing approximately $7.4 million of planned third and fourth quarter',
        'revenue, until HX-9 remediation is complete and verified on their fleet. Trondsen has not',
        'cancelled and has not sought damages.',
        '',
        'No other customer accounted for more than 11 percent of revenue in the quarter.',
      ],
      [
        'HX-9 DEPTH DRIFT — REVISED ESTIMATE AND RECALL',
        '',
        'Field data collected after the second-quarter report changes both the scope and the cost',
        'of this defect.',
        '',
        'Onset is earlier than we reported. Drift begins at approximately 600 hours of continuous',
        'submersion, not the 900 hours stated in the second-quarter report. The 900-hour figure',
        'came from bench testing at constant temperature; the shorter onset appears in units cycled',
        'through thermoclines, which is ordinary operating use.',
        '',
        'The affected population is larger than we reported. Firmware 4.1.3, which we had excluded,',
        'carries the same accumulator defect. The affected population is therefore 7,450 units',
        'rather than the 3,100 units stated in the second-quarter report.',
        '',
        'Approximately 1,200 of those units are on hardware revision B, which cannot accept',
        'firmware 4.4.2 over the vessel link. Those units must be returned and reflashed at a',
        'service centre. We announced this partial recall on 3 July 2026.',
        '',
        'The warranty accrual recorded in the second quarter was $2.4 million, and we stated at the',
        'time that we believed it sufficient. It is not sufficient. We have increased the total',
        'accrual to $6.1 million, recording an additional $3.7 million charge in the third quarter.',
      ],
      [
        'SUPPLY — PT-40 SECOND SOURCE QUALIFIED',
        '',
        'Kaldbakur Semiconductor hf completed qualification as a second source for the PT-40',
        'pressure transducer die on 14 May 2026. The Kaldbakur die passed the 1,000-hour',
        'pressure-cycling test and the salt-fog corrosion test, and a production lot of 4,000 die',
        'was accepted on 2 July 2026.',
        '',
        'Kaldbakur die entered shipped product on 28 July 2026. We expect Kaldbakur to supply',
        'between 30 and 40 percent of PT-40 volume during the fourth quarter of fiscal 2026, rising',
        'to approximately half in fiscal 2027.',
        '',
        'The second-quarter report described the second source as identified and sampled but not',
        'qualified, and described the resulting single-source exposure as unmitigated. That',
        'exposure is now mitigated.',
        '',
        'Separately, on 19 June 2026 we extended the Tessin Micro Fabrication supply agreement to',
        '31 January 2028 on substantially the same commercial terms. We reduced PT-40 inventory',
        'cover from eleven weeks to eight weeks in July, which released $1.1 million of working',
        'capital.',
      ],
      [
        'LIQUIDITY, CAPITAL AND OUTLOOK',
        '',
        'Cash and cash equivalents were $38.2 million at 31 July 2026, against $44.6 million at the',
        'end of the second quarter. The company carries no debt. The reduction is principally the',
        'third-quarter operating loss, $2.9 million of cash warranty spend, and $1.4 million of',
        'capital expenditure.',
        '',
        'REVISED FULL-YEAR GUIDANCE',
        '',
        'Revenue guidance for fiscal 2026 is reduced to $104 million to $109 million, from $118',
        'million to $124 million. Of the approximately $14 million reduction at the midpoint, we',
        'attribute roughly $7.4 million to the deferred Trondsen programmes and the remainder to',
        'slower HX-9 shipments generally while the recall is in progress.',
        '',
        'The revised guidance assumes that the total warranty accrual of $6.1 million is sufficient,',
        'that the recall completes during the fourth quarter, and that Trondsen resumes deliveries',
        'in the first quarter of fiscal 2027. We note that our previous sufficiency estimate for',
        'this defect proved wrong by a factor of more than two.',
        '',
        'This report contains forward-looking statements about a company that does not exist.',
      ],
    ],
  },
]

/**
 * Asked in order, on one conversation, exactly as a visitor would type them.
 *
 * The second and third cannot be answered from either document alone: one asks
 * whether a claim made in Q2 survived into Q3, the other asks how a Q2 risk was
 * finally settled. If a run comes back with those answers citing only one
 * document, the example has stopped demonstrating the thing it exists to
 * demonstrate — `example-run.test.ts` fails the build rather than let that ship.
 */
export const QUESTIONS = [
  'What is the HX-9 depth drift defect, and how many units does Halverd say are affected?',
  'Q2 called the HX-9 warranty accrual sufficient. Did the Q3 report agree, and how did the number change?',
  'Was the second source for the PT-40 die ever qualified, and what happened to the Tessin agreement?',
]
