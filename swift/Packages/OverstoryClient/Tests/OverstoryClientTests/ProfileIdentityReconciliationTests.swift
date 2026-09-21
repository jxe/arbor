import Testing
@testable import OverstoryClient

struct ProfileIdentityReconciliationTests {
    @Test func freshIdentityRequiresExplicitSetup() {
        #expect(ProfileIdentityReconciliation.decide(arbor: nil, keyAvailable: false, native: nil) == .createOrRecover)
    }
    @Test func soleNativeIdentityIsAdopted() {
        #expect(ProfileIdentityReconciliation.decide(arbor: nil, keyAvailable: false, native: "person-a") == .adoptNative)
    }
    @Test func matchingStoresKeepArborUnlessItsKeyNeedsRecovery() {
        #expect(ProfileIdentityReconciliation.decide(arbor: "person-a", keyAvailable: true, native: "person-a") == .useArbor)
        #expect(ProfileIdentityReconciliation.decide(arbor: "person-a", keyAvailable: false, native: "person-a") == .adoptNative)
    }
    @Test func differentIdentitiesNeverMigrateAutomatically() {
        #expect(ProfileIdentityReconciliation.decide(arbor: "person-a", keyAvailable: true, native: "person-b") == .chooseExisting)
        #expect(ProfileIdentityReconciliation.decide(arbor: "person-a", keyAvailable: false, native: "person-b") == .chooseExisting)
    }
    @Test func missingKeyDoesNotCreateAnotherIdentity() {
        #expect(ProfileIdentityReconciliation.decide(arbor: "person-a", keyAvailable: false, native: nil) == .useArbor)
    }
}
