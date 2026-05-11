# Image-edit probe reference fixtures

Six anime/JRPG-style reference images used by `bun sync images` (image-edit capability probe). They mimic the multi-character RP scene Matic described: 1 tavern background + 1 user character + 4 NPC characters = 6 reference images submitted to a model's image-edit endpoint.

These match Matic's actual workload (anime-style RP scene composition) far better than the previous PD oil-painting set. Each character is visually distinct so you can verify whether the model actually placed all 6 references in the output: blonde anime girl, blonde male hero, bearded ranger, bald knight in gold armor, brunette adventurer woman.

For local testing only. Source-license details aren't tracked here because we never redistribute the fixtures - they're inputs to a probe, not part of the released package.

| File                | Subject                                                       | Source                                           |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `00-bg-tavern.jpg`  | Tavern interior - bar, stools, lanterns, shelves with bottles | OpenGameArt: `Tavern1024x768` by Nila122         |
| `01-user-sara.jpg`  | Anime girl, blonde with side braid, blue dress, magenta eyes  | OpenGameArt: `portrait21` (Sara) by RPG Action   |
| `02-npc-trevor.jpg` | Anime male hero, blonde, red royal cape                       | OpenGameArt: `portrait24` (Trevor) by RPG Action |
| `03-npc-puck.jpg`   | Bearded ranger, brown hair, green hood                        | OpenGameArt: `portrait25` (Puck) by RPG Action   |
| `04-npc-knight.jpg` | Bald armored knight, gold armor, mustache                     | OpenGameArt: `portrait26` (knight) by RPG Action |
| `05-npc-rogue.jpg`  | Brunette adventurer woman, leather vest, forest background    | OpenGameArt: `portraits.jpg` cell by Hyptosis    |

## Refresh

If any source 404s in future, the OpenGameArt entries are at:

- Sara/Trevor/Puck/knight: <https://opengameart.org/content/sara-trevor-puck-anime-portrait-and-expressions> (CC-BY 3.0)
- Tavern: <https://opengameart.org/content/tavern-background> (CC-BY-SA 3.0)
- Hyptosis grid: <https://opengameart.org/content/200-free-lorestrome-portraits> (CC0)

Crop pattern (each portrait sheet is 900x760, top-left expression is 330x340):

```bash
magick portrait21.png -crop 330x340+0+0 +repage -background white -alpha remove images/01-user-sara.jpg
```
