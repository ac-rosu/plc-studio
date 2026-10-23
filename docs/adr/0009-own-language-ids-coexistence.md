# Own language ids and coexistence with other SCL extensions

The extension registers its own language ids instead of the common `scl` id, detects other installed extensions that claim the same files, and offers a one-click switch of the file association. It never disables or reconfigures other extensions. Two extensions on the same language produce duplicate diagnostics and completion, and silently taking over would surprise users.
