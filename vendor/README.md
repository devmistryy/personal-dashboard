# Jobs map data

- `d3.min.js`: D3 7.9.0, https://d3js.org/ (ISC license).
- `topojson-client.min.js`: TopoJSON Client 3.1.0, https://github.com/topojson/topojson-client (ISC license).
- `us-states-10m.json`: US Atlas 3, https://github.com/topojson/us-atlas (ISC license).
- `us-metros-2025.json`: derived from the US Census Bureau's 2025 1:5,000,000 CBSA and metropolitan division KML files at https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html. Generate it with `python3 scripts/build_job_metros.py CBSA_ZIP METDIV_ZIP`. The Orange County division is included as a separate override.
