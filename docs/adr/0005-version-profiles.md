# Data-driven version profiles

Everything that differs between TIA versions or CPU families (instructions, data types, conversion rules, syntax features, SD format details, fail-safe rules) is JSON data in a version profile, with later versions inheriting from earlier ones. Supporting a new TIA version means adding a profile and corpus cases, not changing code. Every catalog entry is verified against TIA through the corpus; unverified entries downgrade related diagnostics.
