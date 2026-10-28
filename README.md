# Astrid

Astrid is a video editor. This Pinokio app runs it on your computer, and Pinokio starts, stops and updates it for you. It works on macOS, Linux and Windows.

**Beta.** Astrid on Pinokio is new, so there may be rough edges. If something goes wrong, [tell us](https://github.com/banodoco/astrid-pinokio/issues).

## Two ways to install

- **Install:** Astrid runs on your computer, and you open it at [astrid.haus](https://astrid.haus) in Chrome or Edge. The first time, the browser asks to let astrid.haus reach Astrid on this computer. Choose Allow.
- **Install fully local:** the editor runs on your computer too, at `http://127.0.0.1:5180`. It needs no browser permission, and it opens without the internet (online models still need it). It takes a little longer to install, and astrid.haus won't connect to it.

Started with Install? **Switch to fully local** moves you over at any time.

To go back, choose Reset, then Install. Your projects stay.

## Using Astrid

- **Start** starts Astrid. When it's ready, **Open Astrid** appears.
- **Stop** stops it.
- **Update** updates the hosted install through Pinokio or runs the fully local App updater from its existing session. Open Astrid appears after Runtime is ready. If the new version cannot start, the previous version starts again.
- **Reset** removes Astrid's program files so you can install again.
- **Uninstall** removes Astrid.
- **Uninstall and delete all Astrid data…** also deletes your projects, for good. You type `DELETE` to confirm.

Your projects are kept outside this app's folder, so Update, Reset and Uninstall leave them alone.

## Already installed Astrid another way?

If you installed Astrid with its install command, uninstall that copy first. Your projects stay, and Astrid in Pinokio picks them up.

- macOS and Linux: `curl -fsSL https://astrid.haus/install | sh -s -- --uninstall`
- Windows (PowerShell): `& ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --uninstall`

## If Astrid won't start

- **"Astrid is already running on this computer."** Another copy of Astrid is running. Use Open Astrid, or stop that copy to run Astrid from Pinokio.
- **"Another program is using port 17340…"** Close that program, then try again. Fully local also needs port 5180.

## For testers

In Pinokio's `ENVIRONMENT` file:

- `ASTRID_APP_REF`: leave it empty for normal use. To use a specific astrid-app branch, set its name. After installing fully local, Reset and install again to change it.
- Pinokio's `PINOKIO_SCRIPT_DEFAULT=false` setting is the off switch for automatic Start.

How it works: [commands and installer interface](docs/INTERFACE.md) and [validation notes](docs/VALIDATION.md).
