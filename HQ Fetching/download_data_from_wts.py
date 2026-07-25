import os
import requests
import base64
from datetime import datetime
from dateutil import parser

# Configuration
organization = "WiwynnTrackingSystem"
keywords = ["CRD_", "SKU_", "CRD ", "SKU ", "FRU_", "FRU "] # TODO: can delete the items you don't need to get
pat = "28RfTWXl8wlWeDsot9ig2CXpNwRR0URo4rYrZtPW3erm3hJ4EqUcJQQJ99CGACAAAAAsNR9sAAASAZDOseY9" # Expires on 2027/7/23
project_list_file = "Project_List.cfg"

# Setup log and download folders
timestamp = datetime.now().strftime("%Y-%m-%d")
log_dir = "Log"
wts_dir = os.path.join("WTS")
os.makedirs(log_dir, exist_ok=True)
os.makedirs(wts_dir, exist_ok=True)
log_file_path = os.path.join(log_dir, f"{timestamp}.log")

# Logging function
def log(msg):
    print(msg)
    with open(log_file_path, "a", encoding="utf-8") as f:
        f.write(msg + "\n")

# Auth headers
headers = {
    "Content-Type": "application/json",
    "Authorization": "Basic " + base64.b64encode(f":{pat}".encode()).decode()
}

# Get work item IDs with WIQL (filter by ChangedDate)
def get_recent_workitems(project):
    wiql = {
        "query": f"""
        SELECT [System.Id], [System.Title], [System.State]
        FROM WorkItems
        WHERE [System.TeamProject] = '{project}'
        AND [System.ChangedDate] >= @Today - 10
        ORDER BY [System.ChangedDate] DESC
        """
    } # TODO: change the date from 10 to your expect (example: get all data within 10 days)
    url = f"https://dev.azure.com/{organization}/_apis/wit/wiql?api-version=7.1-preview.2"
    resp = requests.post(url, headers=headers, json=wiql)
    resp.raise_for_status()
    return [item["id"] for item in resp.json()["workItems"]]

# Get full detail of a work item
def get_workitem_detail(project, item_id):
    url = f"https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/{item_id}?$expand=all&api-version=7.1-preview.3"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    return resp.json()

# Process each project
def process_project(project):
    now = datetime.now()
    log(f"============== Processing Project: {project} ==============")
    try:
        item_ids = get_recent_workitems(project)
        log(f"Found {len(item_ids)} recent work items.")
    except Exception as e:
        log(f"Failed to fetch work items for {project}: {e}")
        return

    for item_id in item_ids:
        try:
            detail = get_workitem_detail(project, item_id)
            #print("detail: ", detail)
            #print("detail['fields']: ", detail["fields"])
            title = detail["fields"].get("System.Title", "")
            #print("title: ", title)

            if not any(k in title for k in keywords):
                continue

            # Process attachments
            latest_file = None
            for rel in detail.get("relations", []):
                if rel.get("rel") != "AttachedFile":
                    continue
                attr = rel["attributes"]
                mod_time = parser.parse(attr["resourceModifiedDate"])
                name = attr["name"]

                if not latest_file or mod_time > latest_file["mod_time"]:
                    latest_file = {
                        "url": rel["url"],
                        "name": name,
                        "mod_time": mod_time
                    }

            if not latest_file:
                log(f"No valid attachment found for item {item_id}")
                continue

            filename = latest_file["name"]
            if not (filename.endswith(".xlsx") or (filename.startswith("ECI_") and filename.endswith(".zip"))):
                log(f"Skipped file: {filename}")
                continue

            # Determine save path
            save_path = os.path.join(wts_dir, filename)

            # Download file
            att_id = latest_file["url"].split("/")[-1]
            download_url = f"https://dev.azure.com/{organization}/{project}/_apis/wit/attachments/{att_id}?fileName={att_id}&download=true&api-version=7.1-preview.3"
            resp = requests.get(download_url, headers=headers)
            with open(save_path, "wb") as f:
                f.write(resp.content)
            log(f"Downloaded: {save_path}")

        except Exception as ex:
            log(f"Error processing item {item_id}: {ex}")

def main():
    projects = []
    if os.path.exists(project_list_file):
        with open(project_list_file, encoding="utf-8") as f:
            projects = [line.strip() for line in f if line.strip()]
    
    for proj in projects:
        process_project(proj)

if __name__ == "__main__":
    main()
