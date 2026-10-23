# ADR 0006: node:http gateway without a web framework

Status: accepted

The gateway uses `node:http` with a small route table instead of a framework. The surface is
about 30 routes; body limits, content-type checks, schema validation, rate limiting and error
mapping are explicit in one file. Fewer dependencies reduce supply-chain exposure and keep
validation behavior obvious. Revisit if routing or streaming needs grow.
