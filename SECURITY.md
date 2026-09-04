# Security

IPsycho is a single-operator Telegram bot that stores personal plans and sends
user text to an AI provider only after explicit consent. If you find a
vulnerability, please do not open a public issue.

Report privately to the maintainer (repository owner) via GitHub's private
vulnerability reporting or a direct message on Telegram. Include the commit,
what you observed, and a way to reproduce. You will get an acknowledgement
within three working days.

What we consider in scope: workspace isolation (one user seeing another's
data), consent bypass (user text reaching a provider without consent), secrets
in logs or backups, and anything that lets a Telegram update run code or
mutate state it should not.

Backups are encrypted with a key kept outside the repository and the bucket;
the database port is never published; the app runs as a non-root user and only
makes outbound HTTPS calls.
