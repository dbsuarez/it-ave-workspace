# Call test: real microphones, two computers

Huddles and one-to-one calls are tested automatically between two accounts on one machine with a **simulated**
microphone. What no script can check is the real thing: two people, two devices, real microphones, speakers and
networks. Do this once on the real setup (and again after changing the TURN or network settings).

You need: two computers (or one computer and a phone on the same account type), each signed in as a different
person, with a microphone and speakers or headphones. Use **headphones** to avoid echo.

## 1. Basic call (same network)

1. Person A: **More → People**, open Person B's page, press **+ Huddle**.
2. Person B: a banner "A is calling you" appears with a ring. Press **Join**.
3. Both: say a sentence. Check each hears the other, and the **Mute** button silences you for the other side.
4. Person A: turn the **camera** on, then **share the screen**. Person B sees both.
5. Person B hangs up. Person A's screen shows the call ended.

## 2. Ringing

1. A calls B and B does nothing for 10 seconds: B's ring keeps going, then stops when A hangs up.
2. A calls B and B presses **Decline**: the ring stops.
3. B has Do Not Disturb on (Preferences): no sound, but the banner still shows.

## 3. Channel huddle (three or more)

1. A, B and C open **Huddle**, choose the same channel, press **Join huddle**. All three hear each other.
2. One leaves; the others keep talking.

## 4. Across networks (needs the TURN relay)

Only after following [Calls across firewalls](../deploy/README.md#calls-across-firewalls-turn).

1. Put one person on a phone's mobile hotspot (a different network from the other).
2. Repeat step 1. If audio works, direct connection or the relay is working.
3. To prove the relay itself works, in `.env` set `WEBRTC_ICE_SERVERS` to the TURN entry **only** (no STUN),
   restart the backend, and repeat. If this fails, the TURN ports are closed or the credentials are wrong
   (`docker compose logs turn` shows connection attempts).

## 5. Record the result

Write the date, the two networks, and pass/fail for each step in the handoff notes. Things worth noting if they
fail: echo, delay over about a second, audio only one way, and calls that connect but drop after a minute.
