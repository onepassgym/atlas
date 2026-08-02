#!/bin/bash
# Replaces the application codename globally across the repository.
# Usage: ./scripts/upgrade_version.sh <OldName> <NewName>

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./scripts/upgrade_version.sh <OldName> <NewName>"
  echo "Example: ./scripts/upgrade_version.sh atlas Atlas07"
  exit 1
fi

OLD_NAME=$1
NEW_NAME=$2

OLD_LOWER=$(echo "$OLD_NAME" | tr '[:upper:]' '[:lower:]')
NEW_LOWER=$(echo "$NEW_NAME" | tr '[:upper:]' '[:lower:]')

echo "Upgrading from ${OLD_NAME} to ${NEW_NAME}..."

# Find and replace. Excludes node_modules, git, and dist directories.
find . -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.json" -o -name "*.md" -o -name "*.html" -o -name "*.yml" -o -name "*.css" -o -name "*.sh" -o -name ".env.example" \) -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" -exec perl -pi -e "s/$OLD_NAME/$NEW_NAME/g; s/$OLD_LOWER/$NEW_LOWER/g" {} +

echo "Successfully upgraded codebase to $NEW_NAME!"
echo "Note: You may need to run 'npm install' if package.json or package-lock.json names were modified."
