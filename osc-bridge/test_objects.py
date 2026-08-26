#!/usr/bin/env python3
"""
Exercises per-object playback control in Inviso over OSC.

    pip3 install python-osc
    python3 test_objects.py                       # port 7777, objects 1-3
    python3 test_objects.py 9000                  # another port
    python3 test_objects.py drums vocals          # address by given name
    python3 test_objects.py 9000 drums vocals     # both

Set up first, in the browser:
  1. Create a sound object for each file in audio_test/ and load the file
     into it (File | Input in the object's panel). Audio cannot be loaded
     over OSC, only controlled.
  2. Optionally type a Name for each object. Objects also answer to
     object-1, object-2 and so on, which is what this script uses by default.
  3. Turn OSC on in the top bar and set the port to match.

Watch the line under the port field: it shows each command as it lands, and
says so in orange if the name did not match anything.
"""

import sys
import time

from pythonosc.udp_client import SimpleUDPClient

HOST = "127.0.0.1"
DEFAULT_PORT = 7777
DEFAULT_NAMES = ["object-1", "object-2", "object-3"]

BEAT = 2.5


def main():
    args = sys.argv[1:]

    port = int(args[0]) if args and args[0].isdigit() else DEFAULT_PORT
    names = [a for a in args if not a.isdigit()] or DEFAULT_NAMES

    client = SimpleUDPClient(HOST, port)

    def send(name, command, *values):
        client.send_message("/inviso/object/{}/{}".format(name, command), list(values))
        print("  {:<14} {}".format(name, command + (" " + " ".join(map(str, values)) if values else "")))
        time.sleep(BEAT)

    print("Sending to {}:{}".format(HOST, port))
    print("Objects: {}\n".format(", ".join(names)))

    print("1. Each object on its own")
    for name in names:
        send(name, "play")
        send(name, "pause")

    print("\n2. Pause and resume mid-file")
    first = names[0]
    send(first, "play")
    print("     ... letting it run")
    time.sleep(4)
    send(first, "pause")
    print("     ... resuming; should continue, not restart")
    send(first, "play")

    print("\n3. Reset while playing")
    print("     ... should jump back to the start and keep going")
    send(first, "reset")
    send(first, "pause")

    print("\n4. Looping")
    send(first, "loop", 0)
    print("     ... loop off; this one now stops at the end of the file")
    send(first, "play")
    send(first, "pause")
    send(first, "loop", 1)
    print("     ... loop back on")

    print("\n5. All together")
    for name in names:
        client.send_message("/inviso/object/{}/reset".format(name), [])
        client.send_message("/inviso/object/{}/play".format(name), [])
        print("  {:<14} reset + play".format(name))
    time.sleep(6)

    for name in names:
        client.send_message("/inviso/object/{}/pause".format(name), [])
        print("  {:<14} pause".format(name))
    time.sleep(BEAT)

    print("\n6. Global transport")
    for command in ("play", "pause", "play", "reset"):
        client.send_message("/inviso/transport/{}".format(command), [])
        print("  {:<14} {}".format("transport", command))
        time.sleep(BEAT)

    print("\n7. A name that does not exist")
    print("     ... the panel should say so in orange")
    send("no-such-object", "play")

    print("\nDone.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
