# Methodology

## What "feels like" means here

Feels like uses the National Weather Service's apparent-temperature forecast, based on
temperature, humidity and wind. Local shade and sunshine can change how it feels.

The specification behind that number applies wind chill below 51°F and heat index above
80°F, and between those values apparent temperature equals air temperature. On a mild day
in Los Angeles the two numbers are usually the same. The heat-index component assumes
shade and light wind, so it does not describe standing in direct sun on asphalt.

## Where the forecast comes from

The National Digital Forecast Database, NOAA's gridded mosaic of National Weather Service
forecasts, at 2.5 km resolution over the continental United States. Files come from
NOAA's public distribution bucket, `s3://noaa-ndfd-pds/opnl/AR.conus/VP.001-003/`.

Each cell covers about 1.58 miles across. That resolves the difference between the coast,
the basin, the valleys and the mountains. It does not resolve a block, a building, a stand
of trees or a parking lot.

Forecasts are hourly for the first 36 hours after a run, which supports a rolling
24-hour horizon. The horizon is the next 24 hours from the current hour, not a calendar
day, so a stated peak is the highest value in that window.

## How places work

Place names and boundaries come from
[la-geography](https://github.com/stiles/la-geography), whose countywide layer derives
from the Los Angeles Times' Mapping LA project. That layer covers 270 Los Angeles County
neighborhoods, incorporated cities and unincorporated areas. It is not a set of legally
adopted neighborhood boundaries, and neighborhood council boundaries are a separate
geography.

Searching for a place selects a reviewed reference point inside it and reads the forecast
cell containing that point. Choosing "use my location" reads the cell containing the exact
coordinate instead, and the place name is only a label. Large places may span more than
one cell, and two adjacent small neighborhoods may share one.

## Numbers and display

- Temperatures display as whole degrees Fahrenheit. Calculations use unrounded values.
- Times are stored in UTC and displayed in America/Los_Angeles.
- Map colors use fixed 5°F classes that do not change from hour to hour or season to
  season, so the same color always means the same temperature.
- Contours are interpolated between cell centers for display. The stated temperature for a
  place always comes from its cell, never from the color band under it, so a place within a
  degree of a class break can sit in the adjacent color.
- Missing data is shown as missing. It is never given a temperature color or filled in from
  neighboring cells.

## Attribution

Forecast data from NOAA/National Weather Service. Place boundaries from Mapping LA via
la-geography. Filled contours generated with [isobands](https://palewi.re/docs/isobands/).
