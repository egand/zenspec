# Zen AXI Task Runner

# Default recipe lists all commands
default:
  @just --list

# Run full verification pipeline
check: typecheck lint format-check test build

# Typecheck TypeScript source
typecheck:
  npm run typecheck

# Run ESLint
lint:
  npm run lint

# Check code formatting
format-check:
  npm run format:check

# Fix code formatting and lint errors
fix:
  npm run format
  npm run lint:fix

# Run tests
test:
  npm run test

# Build production bundle
build:
  npm run build

# Run pre-commit hooks on all files
pre-commit:
  pre-commit run --all-files

# Install git pre-commit hooks locally
install-hooks:
  pre-commit install
