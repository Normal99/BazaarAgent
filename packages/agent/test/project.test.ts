import { expect, test, describe } from "bun:test"
import { detectFaults, classifyCondition, estimateRepair, assessProject, projectScore } from "../src/value/project.ts"

describe("telling a fault from a selling point", () => {
  test("work already done is not a cost", () => {
    // The trap this exists for: "registerreim" appears in Norwegian ads far
    // more often as work completed than as a fault. Counting those as repairs
    // would invent tens of thousands of kroner on the best-kept cars.
    for (const text of [
      "Registerreim skiftet ved 120 000 km",
      "Ny registerreim montert i fjor",
      "Nylig byttet clutch og bremser",
      "Turbo overhalt 2024",
    ]) {
      expect(detectFaults(text)).toHaveLength(0)
      expect(classifyCondition(text)).toBe("running")
    }
  })

  test("a fault in the present tense is a cost", () => {
    expect(detectFaults("Registerreima røk, står nå")).toHaveLength(1)
    expect(detectFaults("Clutch slurer og må skiftes")).toHaveLength(1)
    expect(detectFaults("Girkassa er defekt")).toHaveLength(1)
    expect(classifyCondition("Motorhavari, selges rimelig")).toBe("project")
  })

  test("a written-off car is scrap whatever else the ad says", () => {
    expect(classifyCondition("Kondemnert, men nylig skiftet registerreim")).toBe("scrap")
    expect(classifyCondition("Selges i deler")).toBe("scrap")
    expect(classifyCondition("Delebil, mye bra igjen")).toBe("scrap")
  })

  test("an ordinary ad has no faults at all", () => {
    expect(classifyCondition("Pen bil, ett eierskifte, fersk EU og nye dekk.")).toBe("running")
    expect(classifyCondition(null)).toBe("running")
  })

  test("the quote shows what triggered it, so the estimate stays checkable", () => {
    const [fault] = detectFaults("Bilen har dessverre motorhavari etter 210 000 km.")
    expect(fault!.evidence).toContain("motorhavari")
    expect(fault!.label).toContain("Motorhavari")
  })
})

describe("estimating the repair", () => {
  test("overlapping faults are not simply added up", () => {
    // A snapped timing belt IS the engine damage; billing both in full would
    // price the car out of consideration on a double count.
    const both = estimateRepair(detectFaults("Registerreima røk og motoren er defekt"))
    const worst = estimateRepair(detectFaults("Motoren er defekt"))
    expect(both.highNok).toBeGreaterThan(worst.highNok)
    expect(both.highNok).toBeLessThan(worst.highNok * 2)
  })

  test("ranges lean high, because an under-estimate is the expensive mistake", () => {
    const clutch = estimateRepair(detectFaults("Clutch må skiftes"))
    expect(clutch.highNok).toBeGreaterThan(clutch.lowNok * 1.5)
  })

  test("a written-off car is marked terminal and costed at nothing", () => {
    const scrap = estimateRepair(detectFaults("Selges i deler"))
    expect(scrap.terminal).toBe(true)
    expect(scrap.highNok).toBe(0)
  })
})

describe("is the work worth doing", () => {
  const working = 180_000

  test("a cheap car with a known fault can be a good project", () => {
    // 70k car + a 12–28k clutch against a 180k working value.
    const a = assessProject({ fairValueWorking: working, asking: 70_000, repair: estimateRepair(detectFaults("Clutch må skiftes")) })
    expect(a.viable).toBe(true)
    expect(a.headroomLow).toBeGreaterThan(0)
    expect(a.allInHigh).toBeGreaterThan(a.allInLow)
  })

  test("judged at the pessimistic end, not the optimistic one", () => {
    // The risk on a project is always that the fault is bigger than the ad said.
    const a = assessProject({ fairValueWorking: working, asking: 120_000, repair: estimateRepair(detectFaults("Motorhavari")) })
    expect(a.headroomHigh).toBeGreaterThan(a.headroomLow)
    expect(a.viable).toBe(false) // 120k + up to 90k against a 180k car
  })

  test("a thin margin is not viable however cheap the car", () => {
    const a = assessProject({ fairValueWorking: 60_000, asking: 30_000, repair: estimateRepair(detectFaults("Motorhavari")) })
    expect(a.viable).toBe(false)
    expect(a.notes.some((n) => n.includes("taper"))).toBe(true)
  })

  test("the budget covers the whole car, bought and fixed", () => {
    const repair = estimateRepair(detectFaults("Clutch må skiftes"))
    expect(assessProject({ fairValueWorking: working, asking: 70_000, repair, budget: 200_000 }).withinBudget).toBe(true)
    // 70k + 28k worst case is over 90k.
    expect(assessProject({ fairValueWorking: working, asking: 70_000, repair, budget: 90_000 }).withinBudget).toBe(false)
  })

  test("re-registration counts towards the total", () => {
    const repair = estimateRepair(detectFaults("Clutch må skiftes"))
    const without = assessProject({ fairValueWorking: working, asking: 70_000, repair })
    const with_ = assessProject({ fairValueWorking: working, asking: 70_000, repair, omregFee: 6_000 })
    expect(with_.allInHigh).toBe(without.allInHigh + 6_000)
  })

  test("a scrap car is never viable and says why", () => {
    const a = assessProject({ fairValueWorking: working, asking: 5_000, repair: estimateRepair(detectFaults("Selges i deler")) })
    expect(a.viable).toBe(false)
    expect(a.terminal).toBe(true)
    expect(a.notes[0]).toContain("delebil")
  })
})

describe("scoring a project", () => {
  const working = 180_000

  test("scores the margin left, not how cheap the car is", () => {
    // A wreck at 5 000 kr should not outrank a sound project at 70 000 kr.
    const cheapHopeless = assessProject({ fairValueWorking: working, asking: 5_000, repair: estimateRepair(detectFaults("Motorhavari og gjennomrust")) })
    const dearerSound = assessProject({ fairValueWorking: working, asking: 70_000, repair: estimateRepair(detectFaults("Clutch må skiftes")) })
    expect(projectScore(dearerSound, working)).toBeGreaterThan(projectScore(cheapHopeless, working))
  })

  test("a terminal car scores zero", () => {
    const scrap = assessProject({ fairValueWorking: working, asking: 5_000, repair: estimateRepair(detectFaults("Kondemnert")) })
    expect(projectScore(scrap, working)).toBe(0)
  })

  test("more headroom scores higher, monotonically", () => {
    const repair = estimateRepair(detectFaults("Clutch må skiftes"))
    const scores = [110_000, 90_000, 70_000, 50_000].map((asking) =>
      projectScore(assessProject({ fairValueWorking: working, asking, repair }), working),
    )
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!)
  })
})
