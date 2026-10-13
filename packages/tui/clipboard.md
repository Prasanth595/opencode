# Copying over SSH and tmux

On a Linux desktop, OpenCode uses the native desktop clipboard. When an SSH connection forwards X11, OpenCode can also copy to the connecting computer's desktop, including from GNOME Terminal without OSC 52 support.

Connect to a server you trust with X11 forwarding enabled:

```sh
ssh -Y -t user@server 'tmux attach -t work'
```

The server must allow X11 forwarding and have `xauth` available. The connecting desktop needs X11 or XWayland. No OpenCode installation, clipboard utility, or wrapper script is needed on the connecting computer when these system components are already present. Trusted X11 forwarding gives the server access to the local X11 display; use it only with a trusted server.

OpenCode selects the currently attached tmux client on each copy and uses that client's environment. Detaching and reconnecting with a different forwarded display does not require restarting OpenCode. The Linux implementation reads the selected tmux client's environment from `/proc`; it does not use the persistent pane's old `DISPLAY` or tmux's shared session environment.

With ordinary SSH, OpenCode sends an OSC 52 request to the attached terminal. The “Copy sent to terminal” message reports that request, not a confirmed clipboard update. GNOME Terminal versions without OSC 52 support require the X11 forwarding path.

To check manually, start OpenCode in a remote tmux session, connect with the command above, click the working directory and choose **Copy path**, then paste into a local text editor. Detach, reconnect, and repeat without restarting OpenCode. Also check a direct local tmux attach: it should use the local desktop clipboard.

The implementation was checked with both the source CLI and a compiled Linux CLI, GNOME Terminal 3.56.2 / VTE 0.80.1, and tmux 3.5a. Real loopback SSH tests verified a changed forwarding address after reconnect, clipboard contents after detach, normal SSH exit, ordinary SSH feedback, and failed X11 connections. These checks use one physical machine; a second computer still needs manual verification.
