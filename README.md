# Git Submodule Setup: Shared Tools

Instructions for linking and updating the `tools-shared` repository across projects (HALT, Crossroads, etc.).


## 1. Add Submodule to a Parent Project

To link `tools-shared` inside a parent repository (e.g., `HALT` or `Crossroads`), run:

```bash
git submodule add [https://github.com/Designing-Collective-Systems/tools-shared.git](https://github.com/Designing-Collective-Systems/tools-shared.git) tools-shared
git commit -m "Add shared tools"
git push
```

---

## 2. When `tools-shared` Changes, Update Your Parent Project:
```bash
cd tools-shared
git pull
cd ..
git add tools-shared
git commit -m "Update shared tools"
git push
```
