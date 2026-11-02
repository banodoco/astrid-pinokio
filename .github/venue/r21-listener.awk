# The caller requires successful IPv4 loopback readiness and a successful ss capture.
BEGIN { if (pid !~ /^[0-9]+$/) exit 1 }
$1 == "LISTEN" && ($4 == "0.0.0.0:42000" || $4 == "*:42000") && $0 ~ ("pid=" pid "[,)]") { found = 1 }
END { if (!found) exit 1 }
