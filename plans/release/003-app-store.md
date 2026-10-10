# Release 003: the iPhone app on the App Store

**Why and when:** Joe wants Story listed publicly, so that someone can find it without a TestFlight invitation. Later: after [Release 002](002-testflight.md) has friends using the TestFlight build, and when Joe is ready to write the policy pages. This is a sketch of what review requires; plan the steps in detail then.

## Status

- **Effort**: L
- **Risk**: MEDIUM. Review outcomes are not predictable.
- **Depends on**: Release 002
- **Category**: release

## What review requires that Story lacks

- **A way in for the reviewer.** The iPhone app only pairs with an account made on a Mac, and a pairing code works once. Joe decided on 2026-10-10 not to build joining on the iPhone for friends, so this needs its own answer: a demo mode with sample content on the device, or a reviewer account on a demo host with a way to sign the phone in.
- **Account deletion in the app.** A person who joins a host has an account. The app offers only "Disconnect and Pair Again", which leaves the account and its trees on the host. Deleting needs a host route and a decision on what happens to trees the person shared.
- **Report and block for shared content.** People, profiles, photos and shared trees are content from other people. Review expects a way to report it, a way to block a person, terms the person accepts, and a contact who acts on reports.
- **Policy pages.** A privacy policy URL, a support URL, and the App Privacy answers.
- **Listing.** Screenshots for iPhone and iPad, description, age rating, and a review note that explains the Siri voice-note phrases.

## Open questions

- Is the public listing for people with their own host, for people invited to someone's host, or both? The reviewer path and the first-launch screen follow from the answer.
- Does account deletion remove the person's trees from the host, or only the account?
