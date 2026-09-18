"""Build the compact Jobs metro lookup from Census 2025 KML downloads.

Usage: python3 scripts/build_job_metros.py CBSA_ZIP METDIV_ZIP
Sources: https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html
"""

import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


NS = {"k": "http://www.opengis.net/kml/2.2"}


def placemarks(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        kml_name = next(name for name in archive.namelist() if name.endswith(".kml"))
        root = ET.fromstring(archive.read(kml_name))
    return root.findall(".//k:Placemark", NS)


def value(placemark, name):
    node = placemark.find(f'.//k:SimpleData[@name="{name}"]', NS)
    return node.text if node is not None else None


def ring(boundary):
    node = boundary.find(".//k:coordinates", NS)
    if node is None or not node.text:
        return []
    return [[round(float(part), 4) for part in point.split(",")[:2]]
            for point in reversed(node.text.split())]


def geometry(placemark):
    polygons = []
    for polygon in placemark.findall(".//k:Polygon", NS):
        outer = polygon.find("k:outerBoundaryIs", NS)
        if outer is None:
            continue
        rings = [ring(outer)]
        rings.extend(ring(inner) for inner in polygon.findall("k:innerBoundaryIs", NS))
        if len(rings[0]) >= 4:
            polygons.append([coords for coords in rings if len(coords) >= 4])
    return {"type": "MultiPolygon", "coordinates": polygons}


def bounds(shape):
    points = [point for polygon in shape["coordinates"] for ring in polygon for point in ring]
    return [min(point[0] for point in points), min(point[1] for point in points),
            max(point[0] for point in points), max(point[1] for point in points)]


def main(cbsa_zip, metdiv_zip):
    features = []
    for place in placemarks(cbsa_zip):
        if value(place, "LSAD") != "M1":
            continue
        name = value(place, "NAME")
        shape = geometry(place)
        features.append({
            "id": value(place, "CBSAFP"),
            "name": name.split(",")[0].split("-")[0],
            "bbox": bounds(shape),
            "geometry": shape,
        })

    oc = next(place for place in placemarks(metdiv_zip)
              if value(place, "NAME") == "Anaheim-Santa Ana-Irvine, CA")
    oc_shape = geometry(oc)
    features.append({"id": "OC", "name": "Orange County",
                     "bbox": bounds(oc_shape), "geometry": oc_shape})
    output = Path("vendor/us-metros-2025.json")
    output.write_text(json.dumps(features, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(features)} metro boundaries to {output}")


if __name__ == "__main__":
    main(*sys.argv[1:])
