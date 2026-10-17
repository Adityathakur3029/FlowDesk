---
name: commit-push
description: Stage every changed file, commit with a clear message, and push to the current branch's remote. Use this whenever the user says things like "commit and push", "push my changes", "save my work to git", "ship it", "commit everything", or invokes /commit-push, with or without a commit message of their own.
---

# Commit and push

Stage all changes in the current repo, commit them, and push the current branch. The user wants this to be a one-step action, so don't ask for confirmation along the way unless one of the stop conditions below applies.

The user may pass a commit message as the skill argument: $ARGUMENTS
If it's non-empty, use it as the commit message, unchanged. Otherwise write one yourself (step 3).

## 1. Inspect

Run these together:

```bash
git status --short
git branch --show-current
git diff HEAD --stat
git log --oneline -5
```

Stop and tell the user instead of continuing if:
- **Nothing to commit**: the working tree is clean. Then check `git status -sb` for unpushed commits. If there are any, push them (step 5). If there aren't, say there's nothing to do.
- **Detached HEAD**: there's no branch to push.
- **A merge, rebase or cherry-pick is in progress**, or there are unresolved conflicts.
- **The branch is `main` or `master`**: ask before committing straight to the default branch. The user may have forgotten to create a feature branch.

## 2. Check for files that shouldn't be committed

Look through the changed and untracked paths for:
- secrets: `.env` (but `.env.example` is fine), `*.pem`, `*.key`, credential or token files
- build output and dependencies: `node_modules/`, `dist/`, `build/`
- large binaries or dumps

If any appear and aren't gitignored, **don't stage them**. Tell the user which files you left out and why, and suggest adding them to `.gitignore`. Committing a secret is hard to undo once it's pushed, so it's worth the extra moment to check.

## 3. Write the commit message (only if the user didn't give one)

Read the actual changes with `git diff HEAD`, plus untracked file names from `git status`. For a large diff, read the stat output and skim the key files.

Match the style of the recent commits from `git log`. If there's no clear style, use:
- a subject line under ~72 characters, in the imperative mood ("Add Google login spec", not "Added…"), that says *what changed and why*
- a blank line and then a short bullet list of the main changes, but only when the commit touches several unrelated areas

Describe the change itself, not the process. Don't use vague words like "update files" or "misc changes".

If the session's context gives attribution lines for commits (for example a `Co-Authored-By:` trailer), end the message with them.

## 4. Stage and commit

```bash
git add -A                     # then `git reset -- <path>` for anything excluded in step 2
git commit -F - <<'EOF'
<message>
EOF
```

Use a heredoc so quotes and newlines in the message survive the shell.

If a pre-commit hook fails, **don't** bypass it with `--no-verify`. Read the error, fix the problem if it's straightforward (formatting, lint autofix), then re-stage and commit again as a new commit attempt (not `--amend`). If you can't fix it, show the user the hook output and stop.

## 5. Push

```bash
git push
```

If the branch has no upstream yet, run `git push -u origin <branch>`.

If the push is rejected because the remote has new commits, run `git pull --rebase` and push again. If the rebase hits conflicts, stop and tell the user. **Never force-push**: it can destroy other people's commits.

## 6. Report

Keep it short:
- the branch name and the short commit hash
- the commit subject line
- how many files were committed, plus any files you deliberately left out
- whether the push succeeded (for a new upstream, mention it was set)
