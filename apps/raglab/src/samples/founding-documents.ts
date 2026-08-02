import type { GoldSpan, Question } from '../lib/metrics'

/**
 * The bundled sample: a visitor presses "Run benchmark" and sees a full
 * twelve-config comparison in about a minute with no upload and no labelling.
 *
 * Why this text. A benchmark document needs *separable* facts — passages where
 * exactly one span answers the question — or the gold labels are arguable and the
 * scores mean nothing. Constitutional amendments are unusually good at this: each
 * is short, self-contained, factually crisp, and written in a uniform register
 * that gives the embedding model no stylistic shortcut. The near-duplicate voting
 * clauses in the Fifteenth, Nineteenth and Twenty-sixth Amendments are the
 * interesting part: three passages that differ by a handful of words, which is
 * exactly where chunk size and overlap start to matter.
 *
 * Public domain: United States federal government documents carry no copyright.
 * Transcribed from the National Archives text. Selected provisions only — this is
 * a retrieval fixture, not a legal reference.
 */

export interface SampleDocument {
  id: string
  title: string
  source: string
  license: string
  text: string
}

const TEXT = `Constitution of the United States — Selected Provisions

Preamble

We the People of the United States, in Order to form a more perfect Union, establish Justice, insure domestic Tranquility, provide for the common defence, promote the general Welfare, and secure the Blessings of Liberty to ourselves and our Posterity, do ordain and establish this Constitution for the United States of America.

Article I, Section 1

All legislative Powers herein granted shall be vested in a Congress of the United States, which shall consist of a Senate and House of Representatives.

Article I, Section 2

The House of Representatives shall be composed of Members chosen every second Year by the People of the several States, and the Electors in each State shall have the Qualifications requisite for Electors of the most numerous Branch of the State Legislature.

No Person shall be a Representative who shall not have attained to the Age of twenty five Years, and been seven Years a Citizen of the United States, and who shall not, when elected, be an Inhabitant of that State in which he shall be chosen.

Article I, Section 3

The Senate of the United States shall be composed of two Senators from each State, chosen by the Legislature thereof, for six Years; and each Senator shall have one Vote.

No Person shall be a Senator who shall not have attained to the Age of thirty Years, and been nine Years a Citizen of the United States, and who shall not, when elected, be an Inhabitant of that State for which he shall be chosen.

Article II, Section 1

No Person except a natural born Citizen, or a Citizen of the United States, at the time of the Adoption of this Constitution, shall be eligible to the Office of President; neither shall any Person be eligible to that Office who shall not have attained to the Age of thirty five Years, and been fourteen Years a Resident within the United States.

Amendment I

Congress shall make no law respecting an establishment of religion, or prohibiting the free exercise thereof; or abridging the freedom of speech, or of the press; or the right of the people peaceably to assemble, and to petition the Government for a redress of grievances.

Amendment II

A well regulated Militia, being necessary to the security of a free State, the right of the people to keep and bear Arms, shall not be infringed.

Amendment III

No Soldier shall, in time of peace be quartered in any house, without the consent of the Owner, nor in time of war, but in a manner to be prescribed by law.

Amendment IV

The right of the people to be secure in their persons, houses, papers, and effects, against unreasonable searches and seizures, shall not be violated, and no Warrants shall issue, but upon probable cause, supported by Oath or affirmation, and particularly describing the place to be searched, and the persons or things to be seized.

Amendment V

No person shall be held to answer for a capital, or otherwise infamous crime, unless on a presentment or indictment of a Grand Jury, except in cases arising in the land or naval forces, or in the Militia, when in actual service in time of War or public danger; nor shall any person be subject for the same offence to be twice put in jeopardy of life or limb; nor shall be compelled in any criminal case to be a witness against himself, nor be deprived of life, liberty, or property, without due process of law; nor shall private property be taken for public use, without just compensation.

Amendment VI

In all criminal prosecutions, the accused shall enjoy the right to a speedy and public trial, by an impartial jury of the State and district wherein the crime shall have been committed, which district shall have been previously ascertained by law, and to be informed of the nature and cause of the accusation; to be confronted with the witnesses against him; to have compulsory process for obtaining witnesses in his favor, and to have the Assistance of Counsel for his defence.

Amendment VII

In Suits at common law, where the value in controversy shall exceed twenty dollars, the right of trial by jury shall be preserved, and no fact tried by a jury, shall be otherwise re-examined in any Court of the United States, than according to the rules of the common law.

Amendment VIII

Excessive bail shall not be required, nor excessive fines imposed, nor cruel and unusual punishments inflicted.

Amendment IX

The enumeration in the Constitution, of certain rights, shall not be construed to deny or disparage others retained by the people.

Amendment X

The powers not delegated to the United States by the Constitution, nor prohibited by it to the States, are reserved to the States respectively, or to the people.

Amendment XIII

Section 1. Neither slavery nor involuntary servitude, except as a punishment for crime whereof the party shall have been duly convicted, shall exist within the United States, or any place subject to their jurisdiction.

Section 2. The Congress shall have power to enforce this article by appropriate legislation.

Amendment XIV

Section 1. All persons born or naturalized in the United States, and subject to the jurisdiction thereof, are citizens of the United States and of the State wherein they reside. No State shall make or enforce any law which shall abridge the privileges or immunities of citizens of the United States; nor shall any State deprive any person of life, liberty, or property, without due process of law; nor deny to any person within its jurisdiction the equal protection of the laws.

Amendment XV

Section 1. The right of citizens of the United States to vote shall not be denied or abridged by the United States or by any State on account of race, color, or previous condition of servitude.

Amendment XVI

The Congress shall have power to lay and collect taxes on incomes, from whatever source derived, without apportionment among the several States, and without regard to any census or enumeration.

Amendment XVIII

Section 1. After one year from the ratification of this article the manufacture, sale, or transportation of intoxicating liquors within the United States and all territory subject to the jurisdiction thereof for beverage purposes is hereby prohibited.

Amendment XIX

The right of citizens of the United States to vote shall not be denied or abridged by the United States or by any State on account of sex.

Amendment XXI

Section 1. The eighteenth article of amendment to the Constitution of the United States is hereby repealed.

Amendment XXII

Section 1. No person shall be elected to the office of the President more than twice, and no person who has held the office of President, or acted as President, for more than two years of a term to which some other person was elected President shall be elected to the office of the President more than once.

Amendment XXVI

Section 1. The right of citizens of the United States, who are eighteen years of age or older, to vote shall not be denied or abridged by the United States or by any State on account of age.
`

export const SAMPLE_DOC: SampleDocument = {
  id: 'us-constitution-selected',
  title: 'Constitution of the United States — Selected Provisions',
  source: 'National Archives (archives.gov)',
  license: 'Public domain — work of the United States federal government',
  text: TEXT,
}

/**
 * A hand-written label: a question, plus the *verbatim* passage that answers it.
 *
 * Quotes rather than offsets, deliberately. Character indices written by hand rot
 * the moment a line of the document changes, and the resulting drift is invisible
 * — the benchmark keeps running and scores the wrong span. Locating the quote at
 * load time makes the offsets correct by construction, and the accompanying test
 * fails loudly if a quote ever stops matching or stops being unique.
 *
 * These fifteen were written and checked by hand against the text. None are model
 * suggestions.
 */
export interface SampleLabel {
  id: string
  text: string
  quote: string
}

export const SAMPLE_LABELS: SampleLabel[] = [
  {
    id: 'q01-religion-speech',
    text: 'What does the First Amendment say about religion and speech?',
    quote: 'Congress shall make no law respecting an establishment of religion, or prohibiting the free exercise thereof; or abridging the freedom of speech, or of the press',
  },
  {
    id: 'q02-senator-age',
    text: 'How old must a person be to serve as a Senator?',
    quote: 'No Person shall be a Senator who shall not have attained to the Age of thirty Years, and been nine Years a Citizen of the United States',
  },
  {
    id: 'q03-house-term',
    text: 'How often are members of the House of Representatives elected?',
    quote: 'The House of Representatives shall be composed of Members chosen every second Year by the People of the several States',
  },
  {
    id: 'q04-president-eligibility',
    text: 'What age and residency requirements apply to the office of President?',
    quote: 'shall not have attained to the Age of thirty five Years, and been fourteen Years a Resident within the United States',
  },
  {
    id: 'q05-unreasonable-searches',
    text: 'What protects people against unreasonable searches and seizures?',
    quote: 'The right of the people to be secure in their persons, houses, papers, and effects, against unreasonable searches and seizures, shall not be violated',
  },
  {
    id: 'q06-warrant-requirements',
    text: 'What must a search warrant be based on?',
    quote: 'no Warrants shall issue, but upon probable cause, supported by Oath or affirmation, and particularly describing the place to be searched',
  },
  {
    id: 'q07-double-jeopardy',
    text: 'Can someone be prosecuted twice for the same offence?',
    quote: 'nor shall any person be subject for the same offence to be twice put in jeopardy of life or limb',
  },
  {
    id: 'q08-civil-jury-threshold',
    text: 'What is the monetary threshold for a jury trial in a civil suit?',
    quote: 'In Suits at common law, where the value in controversy shall exceed twenty dollars, the right of trial by jury shall be preserved',
  },
  {
    id: 'q09-cruel-unusual',
    text: 'What does the Constitution say about bail, fines and punishment?',
    quote: 'Excessive bail shall not be required, nor excessive fines imposed, nor cruel and unusual punishments inflicted.',
  },
  {
    id: 'q10-reserved-powers',
    text: 'Who holds the powers the Constitution does not give to the federal government?',
    quote: 'The powers not delegated to the United States by the Constitution, nor prohibited by it to the States, are reserved to the States respectively, or to the people.',
  },
  {
    id: 'q11-slavery-abolished',
    text: 'Which provision abolished slavery?',
    quote: 'Neither slavery nor involuntary servitude, except as a punishment for crime whereof the party shall have been duly convicted, shall exist within the United States',
  },
  {
    id: 'q12-birthright-citizenship',
    text: 'Who is a citizen of the United States?',
    quote: 'All persons born or naturalized in the United States, and subject to the jurisdiction thereof, are citizens of the United States and of the State wherein they reside.',
  },
  {
    id: 'q13-suffrage-sex',
    text: 'Which amendment guaranteed women the vote?',
    quote: 'shall not be denied or abridged by the United States or by any State on account of sex.',
  },
  {
    id: 'q14-two-term-limit',
    text: 'How many times may a person be elected President?',
    quote: 'No person shall be elected to the office of the President more than twice',
  },
  {
    id: 'q15-voting-age',
    text: 'What is the minimum voting age?',
    quote: 'who are eighteen years of age or older, to vote shall not be denied or abridged by the United States or by any State on account of age.',
  },
]

/**
 * Resolves a verbatim quote to a character range in the document.
 *
 * Requires exactly one occurrence. A quote that appears twice is not a label, it
 * is an ambiguity — and this document deliberately contains three nearly identical
 * voting clauses, so the check earns its keep.
 */
export function goldFromQuote(text: string, quote: string): GoldSpan {
  const first = text.indexOf(quote)
  if (first === -1) throw new Error(`Gold quote not found in document: ${JSON.stringify(quote)}`)
  const second = text.indexOf(quote, first + 1)
  if (second !== -1) {
    throw new Error(`Gold quote is ambiguous, found more than once: ${JSON.stringify(quote)}`)
  }
  return { start: first, end: first + quote.length }
}

export const SAMPLE_QUESTIONS: Question[] = SAMPLE_LABELS.map((label) => ({
  id: label.id,
  text: label.text,
  gold: goldFromQuote(SAMPLE_DOC.text, label.quote),
}))
