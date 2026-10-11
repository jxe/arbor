# Release 004: an intro video for invited friends

**Why and when:** Joe wants a short video to send with an invitation: getting set up, a tour of the iPhone gestures, and using a folder with an agent. He performs and narrates; an agent session prepares the demo and assembles the cut. After the first release (Release 001, 002) is out and the host is redeployed, since the script shows the download, TestFlight and agent links working.

> **Executor instructions**: Joe records; do not try to perform takes by driving the app. The demo uses a throwaway account on arb.nxhx.org, made and removed with Joe's go-ahead. Keep recordings out of the repository: `dist/` is ignored, so takes go in `dist/video/takes/` and cuts in `dist/video/`.

## Status

- **Effort**: M
- **Risk**: LOW
- **Depends on**: Release 001 and 002 published; the host deployed with agent links; `@ovst/cli` at a version with `agent` commands
- **Category**: release

## Before recording

Each of these must be true, or the script says something the screen cannot show:

- The invitation page offers **Get Story for Mac**: the Mac release is published and the host has `OVERSTORYD_STORY_MAC_URL`.
- The demo iPhone can install from TestFlight: beta review has passed and the demo address is a tester.
- **Use with an agent…** gives a link that works: the host accepts sign-in by device (accounts §5.1) and the published `@ovst/cli` has `agent start`.
- Setup asks for a photo and an identity backup before the folder. The script's "set up your profile" covers the photo; take 3 shows the backup in one click and one line.

## Demo setup (agent session, with Joe)

- A fresh macOS account for the demo, reset with `/Users/Shared/reset-story-test-account.sh` between attempts. Joe's own account logged out or its sync helper stopped while recording there ([Security 011](../security/011-story-sync-local-callers.md)).
- A new invitation with a friendly handle, its link ready in a Messages or Mail window on the demo account, so take 1 starts from a real message.
- A photo to choose, and a small `Notes` folder in Documents with three or four short pages, so the app is not empty after the join.
- A second member with a name and photo (Joe himself is enough), so the Share menu has someone to pick.
- The demo iPhone signed out of Story, with the TestFlight email in its inbox.
- A Claude Code cloud session ready to paste the agent prompt into, and one page in `Notes` with a small task for it ("add three ideas to this list").

## How to record

- **ScreenFlow**, screen and microphone together, one take per row below. Narrating while recording keeps voice and picture in step; nothing is synced afterwards. Redo a take that goes wrong; each is 10 to 25 seconds.
- Mac takes: record the demo account's whole screen at one fixed window size. Hide the Dock and notifications.
- iPhone screen takes: ScreenFlow with the iPhone on a cable, or the iPhone's own screen recording.
- iPhone gesture takes (11 to 14): a screen recording does not show fingers, so film the hand and phone with a second phone, held steady above it, and narrate in the same take or in a separate voice take named to match.
- Name files by take number: `01-invite-link.mov`, `11-swipe.mov`. Leave a second of silence at each end.

## Shot list

The narration is Joe's script, split by take.

### Getting set up

| Take | On screen | Narration |
|---|---|---|
| 01 | The invitation message; click the link; the host's page opens in the browser. | "When you get invited, you get a link to accept an account on my story server." |
| 02 | On the page: Get Story for Mac, open the DMG, drag to Applications, open Story. Back on the page, click Open in Story. (Or paste the link into Story's field.) | "If you go to that link, you can download the app and open it. You can either paste that link in again, or you can click 'open in story' from the link." |
| 03 | Type a name, Join. On the first-steps list: Choose Photo, Back Up (one click, accept), Choose Folder and pick `Notes`. Start Using Story. The folder opens. | "Set up your profile, and you can start syncing a folder from your Mac. Start with a private notes folder." |
| 04 | Open the Share menu; type a name; the suggestion appears; do not confirm. Close it. | "Up here in this share menu, you can share your folder later, with anyone you want." |
| 05 | Open the account menu; Pair another device; the QR code appears. Leave it on screen. | "In this account menu, you can add a device via QR." |
| 06 | iPhone: the TestFlight email, Install, open Story, Scan Pairing QR Code, point at the Mac. The folder appears. | "You should have also gotten an email to try the iOS app on TestFlight. Just open that email on your iPhone, install the app, and scan that code from your mac." |
| 07 | Mac and iPhone side by side (film both, or two clips composed): type a line on one, it appears on the other; then the reverse. | "Now you can edit the same files in both places, and they quickly sync!" |

### Feature tour

| Take | On screen | Narration |
|---|---|---|
| 10 | iPhone in hand, a page open. | "I especially like the gestures and voice support on iOS." |
| 11 | Hand: swipe a line away. | "Swipe to delete." |
| 12 | Hand: pinch to start a recording, and pinch to insert a line. | "Pinch to record or insert." |
| 13 | Hand: drag a line to a new place. | "Drag to reorder." |
| 14 | The voice recording shortcut, then the transcribed text landing in the page. | "And there's a voice recording shortcut." |

### Agents

| Take | On screen | Narration |
|---|---|---|
| 20 | Mac, the `Notes` folder; glance at the iPhone showing the same page. | "Another cool thing is that the same files you edit on your mac or iphone, you can use in a temporary agent session in the cloud." |
| 21 | Share menu, Use with an agent…; the prompt appears; Copy Prompt. | "Just go back to that share sheet, and you can also share it with an agent!" |
| 22 | Claude Code cloud: paste the prompt, add the task, run. Cut to it finishing; then the Mac, where the page has the agent's additions. | "Then over here in claude code cloud, I can just tell it to run in the cloud. Once it's done, it will sync things back to my machine." |

Take 22 has a wait in the middle. Record the paste and start, stop, then record the result arriving on the Mac; the cut hides the wait.

## Assembly (agent session)

With `ffmpeg`, from `dist/video/takes/`:

1. Trim the silence at each end of every take and normalize the audio to one level.
2. For hand-filmed takes with a separate voice take, lay the voice over the picture.
3. Add a title card before each section: Getting set up, Feature tour, Agents.
4. Join in take order, with the same frame size and rate throughout; letterbox the iPhone and hand clips beside or inside a plain background.
5. Burn in captions from the narration column, and also write them as a subtitle file.
6. Write `dist/video/story-intro.mp4`, show Joe, and recut from his notes. Keep the assembly as a script under `dist/video/` so a retake only needs a rerun.

## Close out

Remove the demo account from the host with Joe's go-ahead, note where the video is published in `status.md`, and delete this plan.
