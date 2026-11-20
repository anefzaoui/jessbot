---
name: digital-safety-checkup
description: 'A digital safety check-up for the person or the family (passwords, two-step sign-in, email and bank accounts, phones and computers, home Wi-Fi, kids online), or what to do right now after something went wrong: a hacked account, a leaked password, a scam payment, a lost or stolen phone.'
toolsets: [web, library]
---

# Digital safety check-up

First decide the mode: a calm **check-up** (A), or **something happened** (B). If something happened, go straight to B.

## A. Check-up (one topic at a time)
Go through the topics with `ask_user` rounds (a few questions each, with options), explaining each step in plain words.
Write the how-to steps from the provider's official help pages, looked up now; menus change.
1. **What matters most.** Their main email first (it resets everything else), then bank, phone carrier, Apple or Google
   account, social accounts. Never ask for a password; if they paste one, tell them to change it now.
2. **Passwords.** A password manager (a trusted one such as Bitwarden, 1Password, or the one built into their phone or
   browser); one unique password per important account; start with the main email.
3. **Two-step sign-in.** Passkeys or an authenticator app before SMS codes; recovery codes printed or stored offline.
4. **Breach check** only with their consent: open haveibeenpwned.com in the browser for the email they choose, and
   explain what each breach means for them.
5. **Devices.** Automatic updates on, a screen lock, find-my-device on, backups working (and tested once).
6. **Home Wi-Fi.** The router admin password changed from the default, WPA2 or WPA3, firmware updated, a guest network
   for visitors and smart gadgets.
7. **Children.** Age-appropriate parental controls, which apps they use, and the house rule: never share codes, and tell
   a parent when something feels wrong.
8. **Report.** Save "Safety check-up (<date>)" with `library_create`: what's done, and what's left sorted into *today*,
   *this week*, *when you can*. Offer a reminder in six months to go through it again.

## B. Something happened (calm, short, in order)
1. **What happened, when, which account or card.** One question round, then act.
2. **Money first.** Call the bank on the number on the card or their official site; freeze or block the card; dispute a
   scam payment as soon as possible (time limits apply).
3. **Take the account back from a clean device:** change the password, sign out of all sessions, turn on two-step
   sign-in, and check what an intruder may have changed: forwarding rules and filters in email, the recovery email and
   phone, connected apps. Change the same password anywhere else it was used.
4. **Lost or stolen phone:** locate, lock or erase it with the find-my-device service; ask the carrier to block the SIM.
5. **Report it** to the platform, to the national fraud or cyber-crime agency (search for the right one in their
   country, in the local language too), and to the police if money was lost.
6. **Watch** bank statements for the next weeks; where it exists, a credit freeze. Save the steps done and still to do
   in a dated Library document (the open ones also on a to-do list with `list_add`, if they keep lists), and offer
   reminders for the follow-ups.

Stay calm and kind: people feel embarrassed after a scam. No blame, one step at a time.

## Done when
- The mode is clear and the most urgent step (money, then the main email) was handled first.
- Every step came from an official help page, not from memory of old menus.
- No password or code was asked for or kept in chat.
- A dated Library checklist exists with what's done and what's left, and a follow-up is offered.

Sources: OpenClaw clawdbot-security-check and moltbot-security (ideas, reframed for households); security review drafts (own words).
