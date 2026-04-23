## Git Policy

Do not run `git commit`, `git reset`, `git checkout`, `git merge`, `git rebase`, `git push`, or any other git commands that modify history or branch state. The orchestrator manages all commits and merges.

Make your changes as file edits. They will be committed at the end of the attempt.

You may read git state freely: `git status`, `git diff`, `git log`, `git show`, `git blame`, etc.
