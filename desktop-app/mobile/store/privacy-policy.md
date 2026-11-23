# Handwork for iPhone: Privacy Policy

Effective 19 November 2026

Handwork for iPhone is a companion to the Handwork desktop app. It connects your phone directly to a computer you own that runs Handwork, so you can follow coding sessions and send messages from your phone. This policy explains what the iPhone app does with your information.

## The short version

The developer of Handwork does not collect, receive, or store your data. The app has no account, no analytics, no advertising, and no tracking.

## What stays between your phone and your computer

When you pair the app with Handwork on your desktop, the two devices talk to each other directly over an encrypted connection (QUIC with mutually authenticated TLS 1.3). There is no Handwork server in between. Over this connection the app sends and receives:

- the names of your projects and sessions
- the conversations in those sessions, including messages you send
- file contents, file names, and Git changes you choose to view
- photos or images you attach to a message
- text transcribed from your voice, if you use dictation

This information goes only to your own computer. The developer cannot see it.

## What is stored on your phone

- A pairing identity (a private key and certificate), kept in the iOS Keychain.
- The address and name of your paired desktop, your workspace selection, your settings, and a small cache of recent sessions so the app opens quickly and works briefly offline.

Disconnecting in Settings removes the pairing. Deleting the app removes everything it stored.

## Permissions

- **Camera**: to scan the pairing QR code shown by the desktop app. Images from the camera are not saved or sent anywhere.
- **Local network**: to reach your paired desktop on your Wi-Fi network.
- **Microphone**: to dictate a message. Audio is transcribed on your phone by Apple's on-device speech recognition and is not sent anywhere; only the resulting text is placed in the message box.
- **Photos**: to attach images you pick to a message, or to set a background.
- **Notifications**: to tell you when a session finishes or needs your attention. These are local notifications created on your phone; the app does not register for remote push notifications.

Each permission is optional and can be changed in iOS Settings.

## AI providers

Coding sessions run on your desktop, using the AI providers and accounts you have configured there. Messages you send from the phone are passed to your desktop, which may send them to those providers under their own terms and privacy policies. The iPhone app itself does not send your content to any AI provider.

## Other network requests

The app checks Expo's update service (expo.dev) for app updates. That request includes technical details such as the app version and platform, and does not include your content or any identifier tied to you.

## The demo workspace

"Try the demo" opens a sample workspace stored in the app. Nothing you type in the demo leaves your phone.

## Children

Handwork is a developer tool and is not directed at children under 13.

## Changes

If this policy changes, the new version will be posted at this address with a new effective date.

## Contact

Connor Love
[CONTACT EMAIL]
