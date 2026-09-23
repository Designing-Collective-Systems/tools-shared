# Git Submodule Setup: Shared Tools

Instructions for creating, linking, and updating the `tools-shared` repository across projects (HALT, Crossroads, etc.).

## 1. Repository Creation

Create a new repository under the organization:
* **Repository:** `Designing-Collective-Systems/tools-shared`

---

## 2. Add Submodule to a Parent Project

To link `tools-shared` inside a parent repository (e.g., `HALT` or `Crossroads`), run:

```bash
git submodule add [https://github.com/Designing-Collective-Systems/tools-shared.git](https://github.com/Designing-Collective-Systems/tools-shared.git) tools-shared
git commit -m "Add shared tools"
git push
