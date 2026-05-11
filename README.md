# CoH WWTP SCADA Dashboards

Static web dashboards for City of Houston Wastewater Treatment Plants. Visualizes historical SCADA data (effluent flow, wet well level, pump status) from 2015–present. Replaces Power BI reports — no license, no server, opens directly from the E: drive.

## E: Drive Deployment

**Destination path:**
```
E:\workspace_cohww\workspace_cohww_wwip\wwip_team_projects\Parth\wwtp_dashboards\
```

**To update (city laptop):**
1. `git pull`
2. Copy the `wwtp_dashboards/` folder to the path above

## Data Source

Parquet files on S3:
```
s3://aventdtlkps3stg01/published/scada/summaries/archived/wwtp_wwl_pumpstatus_flow_consolidated/wwtp_flow_wwl_pumps_corrected/
```
FID-to-plant-name mapping: `WWTP_Status_Report.xlsx` in the same S3 prefix.

## Adding / Updating Plants (personal Mac only)

Requires Python venv with pandas, pyarrow, s3fs:
```
python3 -m venv /tmp/wwtp_env
/tmp/wwtp_env/bin/pip install pandas pyarrow s3fs
```

Run for a single plant:
```
/tmp/wwtp_env/bin/python3 preprocess.py --fid 0469
```

Run for all plants:
```
/tmp/wwtp_env/bin/python3 preprocess.py
```

Then commit and push. City laptop pulls and copies to E: drive.

## Plants Built (37)

| FID | Plant | Notes |
|-----|-------|-------|
| 0400 | 69th Street WWTP | Pump tagnames use "400" not "0400" |
| 0146 | Northeast WWTP | |
| 0006 | Almeda Sims WWTP | Pump data under FID 0005 |
| 0083 | F.W.S.D. #23 WWTP | |
| 0469 | Willowbrook WWTP | |
| 0244 | Cedar Bayou WWTP | |
| 0039 | Chocolate Bayou WWTP | |
| 0040 | Clinton Park WWTP | |
| 0171 | Sagemont WWTP | |
| 0189 | Southeast WWTP | |
| 0190 | S.W. Treatment Plant | |
| 0183 | Sims Bayou WWTP | |
| 0252 | Northbelt WWTP | |
| 0145 | Northwest WWTP | |
| 0107 | Homestead WWTP | |
| 0059 | Easthaven WWTP | |
| 0242 | Beltway WWTP | |
| 0237 | West District WWTP | S3 write blocked — deploy via GitHub only |
| 0240 | Greenridge WWTP | |
| 0397 | Metro Central WWTP | |
| 0201 | Turkey Creek WWTP | |
| 0268 | Imperial Valley WWTP | |
| 0250 | Keegan's Bayou WWTP | |
| 0485 | W.C.I.D. #76 WWTP | |
| 0398 | Westway MUD WWTP | |
| 0451 | MC MUD #48 WWTP | |
| 0243 | M.U.D. #203 WWTP | |
| 0274 | White Oak WWTP | |
| 0245 | Park Ten WWTP | |
| 0238 | Intercontinental Airport WWTP | |
| 0225 | W.C.I.D. #47 WWTP | |
| 0279 | W.C.I.D. #111 WWTP | |
| 0286 | Upper Brays WWTP | |
| 0270 | Northgate WWTP | |
| 0498 | Tidwell Timbers WWTP | Pump + wwl data under FID 0499 |
| 0283 | Sims Bayou-South WWTP | |
| 0565 | Forest Cove WWTP | Dual FID — wwl + pumps merged from 0565 + 0566 |

## Not Buildable (no SCADA data)

| FID | Plant | Notes |
|-----|-------|-------|
| 0518 | Kingwood Central WWTP | No pump or wwl data in SCADA |
| 0627 | West Lake Houston TP | No pump or wwl data in SCADA |
