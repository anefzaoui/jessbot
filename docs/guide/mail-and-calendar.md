# Mail and calendar

Connecting your mailbox and calendar lets the assistant check your email, find a message, write replies, know what's
coming up and add events for you. It's optional, each account belongs to one person, and anything that sends mail or
changes your calendar stops for your OK first, unless you chose to always allow it. This page explains how to connect
an account and what the assistant can then do with it.

## Connecting an account

Go to **You → Connections**. There is an **Email** section with **Add a mailbox** and a **Calendar** section with
**Add a calendar**. In the form:

1. Pick your **Provider**. Gmail, iCloud, Yahoo and Fastmail fill in the mail servers for you; iCloud, Yahoo, Fastmail
   and Nextcloud fill in the calendar address. Choose **Other** for anything else.
2. Enter your **Username** and an **App password**. Most providers ask for an app password instead of your normal one
   once two-step sign-in is on, and the form shows where your provider makes one.
3. For mail, **Send as** is the address your messages come from (the username, unless you change it). For a calendar,
   **CalDAV address** is your server's calendar address.
4. Under **Servers** you can change the incoming (IMAP) and outgoing (SMTP) servers and ports, and tick **Trust a
   self-signed certificate** for a server you run yourself.
5. Give it a name under **Name it** (for example "Work mail") and press **Check and connect**.

Jessbot signs in to the real server before it saves anything, so a wrong password is never stored. Each connection then
shows whether it is working; **Test** checks it again and the bin icon (**Remove**) disconnects it. You can connect
more than one mailbox or calendar, and ask for a specific one by its name.

Google Calendar isn't supported yet, because it needs Google sign-in. Gmail itself works with an app password.

## Private to you

- Each account can only be used by the person who connected it, for their own requests. Not even an admin can use it.
- Passwords are stored encrypted on this computer and never shown again. The encryption key lives in this install's
  `.env`, so a copy of the database or a backup alone doesn't reveal them. When you move Jessbot to another machine,
  bring `.env` along.
- Mail and calendar servers must be on the public internet. A server on this computer or your home network is refused
  unless an admin turns on **Allow the local network** in Admin → Browser.

## What the assistant can do with your mail

- **Check and search** your mailbox: unread mail, mail from someone, words in the subject or the text, mail since a
  date, other folders.
- **Read a message** in full. Reading doesn't mark it as read.
- **Save attachments** to your Library: PDFs, pictures, Office files and text. Programs, files with macros and archives
  are never kept.
- **Send an email** from your own address, as a new message or a reply, with up to 5 of your own Library files (20 MB
  in all). Sending shows the full message on an approval card first.
- **Tidy up**: mark as read or unread, flag, archive or move messages. Nothing is ever deleted. More than 20 messages at
  once, or a move to the bin or spam, asks first.
- **Find how to unsubscribe** from a mailing list. It shows you the link; it never follows it.

## What the assistant can do with your calendar

- **Look at your calendar**: what's on today, when your next appointment is. Events from yesterday to 60 days ahead
  are kept up to date every 15 minutes, so the assistant knows what's coming up and the Upcoming page shows it.
- **Add, move, change or delete an event.** Each change shows an approval card with the details first.
- **Find free time**, worked out exactly from your calendars, with a daily window, the days you want and a buffer
  around events if you ask for one.

No calendar connected? The assistant can still make a calendar file (.ics) in your Library with one or many events (a
trip, a fixture list, school term dates), which a phone adds with one tap.

## Finding a time together

On You → Connections, **Share when I'm busy with** your groups lets the assistant count the hours you're busy when
someone in your group asks for a time that suits everyone. It shares only the busy times, never what the events are or
who they're with. **Who looked at my availability** lists every time someone's request counted your busy hours over the
last 90 days. The switch only works once you're in a group.

## Approvals and what it read

Sending mail and changing your calendar ask first. Choosing "Always allow" on one of those cards stops the asking, but
only until a task reads something from outside: an email you received counts, so a task that read your inbox asks
again before it sends. See [Approvals and safety](approvals-and-safety.md) for the details.

An admin can turn the Email or Calendar permission off for a person, a group or everyone in Admin → Permissions.

Related: [Guide index](README.md) · [Approvals and safety](approvals-and-safety.md) · [Library](library.md) ·
[People and admin](people-and-admin.md) · [FAQ](faq.md) · [Troubleshooting](troubleshooting.md)
