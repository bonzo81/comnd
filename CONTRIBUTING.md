# Contributing to netssh

## Knowledge Base Contributions

The easiest way to contribute is adding commands to the knowledge base.

### Adding a command

1. Find the right file in `knowledge-base/<platform>/commands/<category>.yaml`
2. Add your command entry following the schema:

```yaml
  - name: show ip ospf neighbor
    syntax: "show ip ospf [<process-id>] neighbor [detail]"
    description: |
      Displays OSPF neighbor adjacency information.
      Shows neighbor state, priority, dead time, and interface.
    category: routing
    mode: privileged-exec
    aliases:
      - sh ip ospf nei
    examples:
      - command: show ip ospf neighbor
        description: All OSPF neighbors
      - command: show ip ospf neighbor detail
        description: Detailed neighbor information
    versions:
      introduced: "12.0"
      deprecated: null
      notes: null
    tags:
      - ospf
      - routing
      - troubleshooting
```

### Rules
- Every command needs: name, syntax, description, category, mode, at least one example
- Aliases should include common abbreviations engineers actually use
- Descriptions should be practical — what the command does and when you'd use it
- Version `introduced` should be the earliest major version where the command exists
- Tags help with search — include the protocol, category, and use case
