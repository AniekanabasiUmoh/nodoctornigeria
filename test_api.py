import requests
import json
import time

def test_endpoint(url, payload, name):
    print(f"Testing {name}...")
    try:
        response = requests.post(url, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error testing {name}: {e}")
        try:
            return response.json()
        except:
            return str(e)

base_url = "http://127.0.0.1:8000"

tests = [
    {
        "name": "Village Nurse Persona",
        "url": f"{base_url}/api/community/query",
        "payload": {"query": "child fever and rash immediate care", "top_k": 5}
    },
    {
        "name": "Non-English Speaker Persona",
        "url": f"{base_url}/api/community/query",
        "payload": {"query": "child stomach pain bad not eat", "top_k": 5}
    },
    {
        "name": "Medical Doctor Persona",
        "url": f"{base_url}/api/clinical/query",
        "payload": {"query": "latest management guidelines for Diabetic Ketoacidosis (DKA) in adults, including fluid resuscitation and insulin therapy protocols", "top_k": 5}
    },
    {
        "name": "Remote Community Member Persona",
        "url": f"{base_url}/api/community/query",
        "payload": {"query": "persistent cough shortness of breath far from clinic", "top_k": 5}
    }
]

results = {}
for test in tests:
    results[test["name"]] = test_endpoint(test["url"], test["payload"], test["name"])
    time.sleep(1) # Be nice to the API

with open("api_test_results.json", "w") as f:
    json.dump(results, f, indent=2)

print("Testing complete. Results saved to api_test_results.json")
