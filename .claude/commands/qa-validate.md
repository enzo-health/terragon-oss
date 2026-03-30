# QA Validate Command

Run QA validation on a thread to check consistency across UI, database, and container states.

## Usage

```bash
# Basic validation
terry qa verify <thread-id>

# Deep validation with event journal
terry qa verify <thread-id> --deep

# Watch mode for continuous monitoring
terry qa watch <thread-id> --interval 10000
```

## When to Use

- Debugging stuck tasks
- Verifying delivery loop correctness
- Checking container health for active runs
- Investigating UI/database inconsistencies

## Interpreting Results

- **HEALTHY**: All sources agree, no action needed
- **CRITICAL**: Fix immediately (container down, state mismatch)
- **WARNING**: Investigate (cache stale, PR linkage issue)
- **INFO**: FYI only (version skew)
