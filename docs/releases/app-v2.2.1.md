# GitStudio 2.2.1 — updates that ask, and your account from the first second

## You're told about an update every time

The question could close itself a moment after it appeared: a background
refresh or a tab switch answered it "Cancel", and it didn't come back until
you quit. On macOS, a window reopened from the Dock was never told about an
update that had already been found.

The question now stays until you answer it, and a window that opens later
asks as well. When GitStudio isn't in front, a system notification says a new
version is out. A check that fails at launch (offline, say) is tried again in
15 minutes instead of 4 hours.

**If you're on 2.2.0,** that version may not ask you about this one, so
install 2.2.1 once by hand. Use `brew upgrade --cask gitstudio` or the
download below. From then on, updates ask for themselves.

## Your GitHub account shows at launch

The top bar said "Signed in" and Settings said "you" until something else
happened to ask GitHub who you are. The account name is now read with your
sign-in and remembered, so your name and picture are there as soon as the
window is.
