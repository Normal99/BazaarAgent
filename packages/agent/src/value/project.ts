// Project cars: broken, but broken by a knowable amount.
//
// The ordinary feed asks "is this cheaper than the market?". A mechanic asks a
// different question: "is the asking price plus what it costs to fix it still
// less than a working one is worth?" A car with a dead clutch is not a bad
// deal at 40 000 kr — it is a 70 000 kr car with a 15 000 kr job attached, and
// whether that is worth doing is arithmetic rather than judgement.
//
// The agent already had this population and was throwing it away:
// looksLikePartsCar() disqualified anything that could not be driven home. That
// is right for a buyer who wants to drive it home, and exactly wrong for
// someone with a workshop.

export type Condition = "running" | "project" | "scrap"

export interface Fault {
  readonly label: string
  /** Realistic Norwegian workshop range, parts and labour. */
  readonly lowNok: number
  readonly highNok: number
  /** What the ad said, so the estimate stays checkable. */
  readonly evidence: string
  /** A job that usually costs more than the car is worth. */
  readonly terminal?: boolean
}

interface FaultSpec {
  readonly label: string
  readonly match: RegExp
  readonly lowNok: number
  readonly highNok: number
  readonly terminal?: boolean
}

/**
 * Costs are deliberately wide and lean high.
 *
 * An under-estimate sends someone to buy a car on a promise that does not hold;
 * an over-estimate only means passing on a marginal one. "Needs a clutch" also
 * turns out to be a gearbox often enough that the top of the range has to
 * allow for it.
 */
// Stems rather than whole words throughout. Norwegian glues the article onto
// the noun — girkasse becomes girkassa or girkassen, bremse becomes bremsene —
// and a pattern written against the indefinite form silently misses the way
// people actually write. "Girkassa er defekt" matched nothing until this.
const FAULTS: FaultSpec[] = [
  { label: "Motorhavari eller defekt motor", match: /motorhavari|defekt\s+motor|motoren?\s+er\s+(defekt|[øo]delagt)|kastet\s+beina/i, lowNok: 25_000, highNok: 90_000 },
  { label: "Registerreim ryket", match: /registerreim\w*\s*(har\s+)?(ryket|r[øo]k|gikk|brast)/i, lowNok: 30_000, highNok: 95_000 },
  { label: "Registerreim må skiftes", match: /registerreim\w*\s*(m[åa]|skal|trenger|bør)\s*(skiftes|byttes)/i, lowNok: 8_000, highNok: 18_000 },
  { label: "Girkasse", match: /girkass\w*\s*(er\s+)?(defekt|[øo]delagt|m[åa]\s+(skiftes|byttes)|problem|slurer)|automatkass\w*\s*(er\s+)?(defekt|problem)/i, lowNok: 20_000, highNok: 60_000 },
  { label: "Clutch", match: /clutch\w*\s*(er\s+)?(defekt|slurer|m[åa]\s+(skiftes|byttes)|slitt)|kl[øo]tsj\w*\s*(m[åa]|defekt)/i, lowNok: 12_000, highNok: 28_000 },
  { label: "Turbo", match: /turbo\w*\s*(er\s+)?(defekt|[øo]delagt|m[åa]\s+(skiftes|byttes))/i, lowNok: 15_000, highNok: 40_000 },
  { label: "Partikkelfilter / DPF", match: /\b(dpf|partikkelfilter)\b[^.]{0,40}(defekt|t[ett]|m[åa]|problem)/i, lowNok: 12_000, highNok: 35_000 },
  { label: "EU-kontroll med mangler", match: /(ikke\s+godkjent|m[åa]\s+p[åa]|stryk\w*\s+p[åa])\s*eu|eu[- ]?kontroll\w*\s*(med\s+)?(mangler|avvik|anmerkning)/i, lowNok: 5_000, highNok: 20_000 },
  { label: "Bremser", match: /brems\w*\s*(m[åa]|trenger|er\s+(defekt|slitt))/i, lowNok: 4_000, highNok: 14_000 },
  { label: "Starter ikke", match: /starter\s+ikke|f[åa]r\s+ikke\s+start|vil\s+ikke\s+starte/i, lowNok: 5_000, highNok: 60_000 },
  { label: "Rustarbeid", match: /gjennomrust|mye\s+rust|rust\w*\s*(m[åa]|som\s+m[åa]|krever)/i, lowNok: 15_000, highNok: 70_000 },
  { label: "Kamkjede", match: /kamkjed\w*\s*(m[åa]|defekt|st[øo]y|rasler)/i, lowNok: 18_000, highNok: 45_000 },
  { label: "Kondemnert", match: /kondemnert/i, lowNok: 0, highNok: 0, terminal: true },
  { label: "Vrak", match: /\bvrak\b|totalvrak/i, lowNok: 0, highNok: 0, terminal: true },
  { label: "Selges i deler", match: /selges?\s+i\s+deler|\bdelebil\b|til\s+deler\b|uten\s+motor/i, lowNok: 0, highNok: 0, terminal: true },
]

/**
 * A fault mentioned in the past tense is a selling point, not a cost.
 *
 * This matters more than it sounds. "Registerreim" appears in a Norwegian ad
 * far more often as "registerreim skiftet ved 120 000 km" — work already done,
 * which raises the price — than as a fault. Counting those as repairs would
 * invent tens of thousands of kroner of work on the best-maintained cars in
 * the feed.
 */
const ALREADY_DONE = /\b(skiftet|byttet|ny(e|tt)?|nylig|overhalt|reparert|utf[øo]rt|montert|gjort)\b/i

function mentionsRepairDone(text: string, at: number): boolean {
  // A generous window either side: Norwegian puts the verb at either end.
  return ALREADY_DONE.test(text.slice(Math.max(0, at - 60), at + 90))
}

export function detectFaults(description: string | null | undefined): Fault[] {
  if (!description) return []
  const found: Fault[] = []

  for (const spec of FAULTS) {
    const match = spec.match.exec(description)
    if (!match) continue
    // A terminal marker means the seller has already written the car off; no
    // amount of "nylig" nearby changes that.
    if (!spec.terminal && mentionsRepairDone(description, match.index)) continue

    const evidence = description
      .slice(Math.max(0, match.index - 30), match.index + match[0].length + 50)
      .replace(/\s+/g, " ")
      .trim()
    found.push({ label: spec.label, lowNok: spec.lowNok, highNok: spec.highNok, evidence: `…${evidence}…`, terminal: spec.terminal })
  }
  return found
}

export function classifyCondition(description: string | null | undefined): Condition {
  const faults = detectFaults(description)
  if (faults.some((f) => f.terminal)) return "scrap"
  return faults.length > 0 ? "project" : "running"
}

export interface RepairEstimate {
  readonly faults: Fault[]
  readonly lowNok: number
  readonly highNok: number
  /** Whether the seller has written the car off entirely. */
  readonly terminal: boolean
}

export function estimateRepair(faults: readonly Fault[]): RepairEstimate {
  const terminal = faults.some((f) => f.terminal)
  // Faults overlap — a snapped timing belt IS the engine damage — so the
  // total is not a straight sum. The largest job plus a share of the rest is
  // closer to what a workshop actually bills.
  const sorted = [...faults].filter((f) => !f.terminal).sort((a, b) => b.highNok - a.highNok)
  const combine = (pick: (f: Fault) => number) =>
    sorted.reduce((total, fault, index) => total + (index === 0 ? pick(fault) : pick(fault) * 0.5), 0)

  return { faults: [...faults], lowNok: Math.round(combine((f) => f.lowNok)), highNok: Math.round(combine((f) => f.highNok)), terminal }
}

export interface ProjectInput {
  /** What a working example of this car sells for. */
  readonly fairValueWorking: number
  readonly asking: number
  readonly repair: RepairEstimate
  /** Total the buyer is willing to have in the car, bought and fixed. */
  readonly budget?: number
  /** Re-registration, where it applies. */
  readonly omregFee?: number
}

export interface ProjectAssessment {
  readonly asking: number
  readonly repairLow: number
  readonly repairHigh: number
  /** Everything in, at the pessimistic end of the repair range. */
  readonly allInHigh: number
  readonly allInLow: number
  /** Working value less the all-in cost. Positive means the work is worth doing. */
  readonly headroomLow: number
  readonly headroomHigh: number
  readonly withinBudget: boolean
  readonly viable: boolean
  readonly terminal: boolean
  readonly notes: string[]
}

/** Below this the margin does not pay for the risk of what the ad did not mention. */
const MIN_HEADROOM_NOK = 15_000
const MIN_HEADROOM_SHARE = 0.15

export function assessProject(input: ProjectInput): ProjectAssessment {
  const { fairValueWorking, asking, repair } = input
  const omreg = input.omregFee ?? 0
  const allInLow = asking + omreg + repair.lowNok
  const allInHigh = asking + omreg + repair.highNok
  const headroomLow = fairValueWorking - allInHigh
  const headroomHigh = fairValueWorking - allInLow
  const withinBudget = input.budget == null || allInHigh <= input.budget

  const notes: string[] = []
  if (repair.terminal) notes.push("Selger har avskrevet bilen — dette er en delebil, ikke et prosjekt.")
  else {
    notes.push(`Verdt ${kr(fairValueWorking)} i kjørbar stand.`)
    notes.push(`Kjøp ${kr(asking)}${omreg ? ` + ${kr(omreg)} omreg.` : ""} + reparasjon ${kr(repair.lowNok)}–${kr(repair.highNok)}.`)
    notes.push(
      headroomLow > 0
        ? `Selv i verste fall står du igjen med ${kr(headroomLow)}.`
        : `I verste fall taper du ${kr(-headroomLow)}. Marginen er for tynn til å tåle overraskelser.`,
    )
    if (input.budget != null)
      notes.push(withinBudget ? `Alt inkludert holder seg under budsjettet på ${kr(input.budget)}.` : `Alt inkludert sprenger budsjettet på ${kr(input.budget)}.`)
    // Someone has to do the work, and the estimate assumes a workshop rate.
    notes.push("Anslagene er verkstedpriser og vide med vilje. Få bilen vurdert før du byr.")
  }

  // Judged at the pessimistic end: the risk on a project car is always that
  // the fault is bigger than the advert admitted.
  const viable =
    !repair.terminal &&
    withinBudget &&
    headroomLow >= MIN_HEADROOM_NOK &&
    headroomLow >= fairValueWorking * MIN_HEADROOM_SHARE

  return { asking, repairLow: repair.lowNok, repairHigh: repair.highNok, allInLow, allInHigh, headroomLow, headroomHigh, withinBudget, viable, terminal: repair.terminal, notes }
}

/**
 * Score a project on the margin it leaves, not on how cheap it is.
 *
 * A wreck at 5 000 kr scores badly here and should: the question is never the
 * asking price, it is what is left once the car runs.
 */
export function projectScore(assessment: ProjectAssessment, fairValueWorking: number): number {
  if (assessment.terminal || fairValueWorking <= 0) return 0
  const share = assessment.headroomLow / fairValueWorking
  // 40% headroom at the pessimistic end is about as good as these get.
  const scaled = 5 + (Math.max(-0.3, Math.min(0.4, share)) / 0.4) * 5
  return Math.max(0, Math.min(10, Number(scaled.toFixed(2))))
}

const kr = (n: number) => `${Math.round(n).toLocaleString("nb-NO")} kr`
