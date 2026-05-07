# Image-edit probe reference fixtures

Six SFW reference images used by `bun sync images` (image-edit capability probe). They mimic the multi-character RP scene Matic described: 1 background + 1 user character sprite + 4 NPC sprites = 6 reference images submitted to a model's `/v1/images/edits` endpoint.

All are 640px-wide JPEG thumbnails sourced from Wikimedia Commons. Each underlying work is **public domain** (artist died > 100 years ago) and Wikimedia distributes the digital reproductions as PD-Art / PD-old. No attribution is legally required, but the source is documented here for transparency.

| File | Source title | Author | URL |
|---|---|---|---|
| `00-bg-room.jpg` | Peasant family at home (1647) | Adriaen van Ostade | [Commons file page](https://commons.wikimedia.org/wiki/File:Adriaen_van_Ostade_001.jpg) |
| `01-user-girl.jpg` | La belle ferronnière (c. 1490–1497) | School of Leonardo da Vinci | [Commons file page](https://commons.wikimedia.org/wiki/File:La_belle_ferronnière,Leonardo_da_Vinci_-_Louvre.jpg) |
| `02-npc-warrior.jpg` | Charles I (1600–49) (1635–36) | Anthony van Dyck | [Commons file page](https://commons.wikimedia.org/wiki/File:Sir_Anthony_Van_Dyck_-_Charles_I_(1600-49)_-_Google_Art_Project.jpg) |
| `03-npc-mage.jpg` | Aristotle (Altemps Inv. 8575) | Roman copy after Greek original | [Commons file page](https://commons.wikimedia.org/wiki/File:Aristotle_Altemps_Inv8575.jpg) |
| `04-npc-rogue.jpg` | Self-Portrait | Rembrandt van Rijn | [Commons file page](https://commons.wikimedia.org/wiki/File:Rembrandt_van_Rijn_-_Self-Portrait_-_Google_Art_Project.jpg) |
| `05-npc-merchant.jpg` | Banquet Scene in a Renaissance Hall | Dirck Hals | [Commons file page](https://commons.wikimedia.org/wiki/File:Dirck_Hals_-_Banquet_Scene_in_a_Renaissance_Hall_-_WGA11035.jpg) |

## Refresh

If a Commons URL ever 404s, re-download with the same filename. The Commons search API resolves any title to a stable upload URL:

```bash
curl -sL "https://commons.wikimedia.org/w/api.php?action=query&titles=File:<URL-encoded>&prop=imageinfo&iiprop=url&format=json"
```

Always pass a meaningful `User-Agent` (Wikimedia rejects empty UAs). Use the 640px-wide thumbnail variant when the original is large; pattern is `/commons/thumb/<hash>/<file>/640px-<file>`.
