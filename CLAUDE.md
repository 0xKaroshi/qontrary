# Qontrary — Claude Code Rules

## Architecture
- This is a multi-agent orchestration framework
- All agents are in packages/core/src/agents/
- Pipeline logic is in packages/core/src/pipeline/
- Never modify .env files directly

## Code Style
- TypeScript strict mode
- No any types
- Every function must have JSDoc comments
- Error handling: always use try/catch with typed errors
- All agent outputs must conform to their defined interfaces

## Testing
- Write tests for every agent
- Tests go in __tests__/ directories next to source
- Use vitest

## Safety
- Never hardcode API keys
- All model calls must go through the circuit breaker
- Sandbox execution must use E2B — never run user code locally
