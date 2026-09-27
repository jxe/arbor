import Testing
@testable import Overstory

private let minute = 60_000

@Test func anHoursSessionIsReplacedFiveMinutesBeforeItExpires() {
    #expect(deviceSessionUsable(expiresAt: 60 * minute, openedAt: 0, now: 54 * minute))
    #expect(!deviceSessionUsable(expiresAt: 60 * minute, openedAt: 0, now: 55 * minute))
}

@Test func aShortSessionIsReusedForThreeQuartersOfIt() {
    #expect(deviceSessionUsable(expiresAt: 2 * minute, openedAt: 0, now: 89_000))
    #expect(!deviceSessionUsable(expiresAt: 2 * minute, openedAt: 0, now: 90_000))
}
