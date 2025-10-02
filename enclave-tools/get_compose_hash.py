#!/usr/bin/env python3
"""
App Compose Hash Generation for Audit
Based on DStack SDK implementation for deterministic JSON serialization
"""

import hashlib
import json
import yaml
from typing import Any, Dict, List, Optional, Union


def sort_object(obj: Any) -> Any:
    """Recursively sort object keys lexicographically for deterministic JSON."""
    if obj is None:
        return obj
    elif isinstance(obj, list):
        return [sort_object(item) for item in obj]
    elif isinstance(obj, dict):
        return {key: sort_object(value) for key, value in sorted(obj.items())}
    else:
        return obj


def to_deterministic_json(data: Dict[str, Any]) -> str:
    """Serialize to deterministic JSON following cross-language standards."""
    def convert_special_values(obj: Any) -> Any:
        """Convert NaN and Infinity to null for deterministic output."""
        if isinstance(obj, float):
            if obj != obj:  # NaN check
                return None
            if obj == float("inf") or obj == float("-inf"):
                return None
        return obj

    def process_data(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {key: process_data(value) for key, value in obj.items()}
        elif isinstance(obj, list):
            return [process_data(item) for item in obj]
        else:
            return convert_special_values(obj)

    sorted_data = sort_object(data)
    processed_data = process_data(sorted_data)
    return json.dumps(processed_data, separators=(",", ":"), ensure_ascii=False)


def get_compose_hash(app_compose_data: Dict[str, Any]) -> str:
    """Calculate SHA256 hash of app compose configuration."""
    manifest_str = to_deterministic_json(app_compose_data)
    return hashlib.sha256(manifest_str.encode("utf-8")).hexdigest()


def docker_compose_to_app_compose(docker_compose_path: str) -> Dict[str, Any]:
    """Convert docker-compose.yml to app-compose.json equivalent"""
    with open(docker_compose_path, 'r') as f:
        docker_config = yaml.safe_load(f)

    # Extract the primary service configuration
    services = docker_config.get('services', {})
    if not services:
        raise ValueError("No services found in docker-compose.yml")

    primary_service = list(services.keys())[0]
    primary_config = services[primary_service]

    # Create app-compose equivalent based on the audit environment
    app_compose = {
        "runner": "docker-compose",
        "manifest_version": 1,
        "name": f"xordi-audit-{primary_service}",
        "docker_compose_file": docker_compose_path,
        "public_logs": False,
        "public_sysinfo": False,
        "public_tcbinfo": True,
        "kms_enabled": True,
        "gateway_enabled": True,
        "key_provider": "kms",
        "key_provider_id": "kms-base-prod7",  # Standard KMS ID for production
        "no_instance_id": False,
        "secure_time": True,
        "allowed_envs": ["BROWSER_MANAGER_URL", "DOCKER_HOST"],

        # Include docker-specific configurations for audit transparency
        "_audit_metadata": {
            "dockerfile": primary_config.get("build", {}).get("dockerfile"),
            "context": primary_config.get("build", {}).get("context"),
            "ports": primary_config.get("ports", []),
            "environment": primary_config.get("environment", []),
            "volumes": primary_config.get("volumes", []),
            "networks": list(docker_config.get("networks", {}).keys()),
            "services_count": len(services),
            "service_names": list(services.keys())
        }
    }

    return app_compose


def main():
    docker_compose_path = "../docker-compose-audit.yml"

    print("=== Generating App Compose Hash ===")

    # Convert to app-compose format
    app_compose_data = docker_compose_to_app_compose(docker_compose_path)

    # Save for inspection
    with open('app-compose.json', 'w') as f:
        json.dump(app_compose_data, f, indent=2)

    # Generate deterministic JSON for hash calculation
    deterministic_json = to_deterministic_json(app_compose_data)
    with open('app-compose-deterministic.json', 'w') as f:
        f.write(deterministic_json)

    # Generate hash
    compose_hash = get_compose_hash(app_compose_data)

    print(f"App Compose Hash: {compose_hash}")
    print(f"Hash (first 40 chars): {compose_hash[:40]}")

    # Save hash for verification
    with open('compose-hash.txt', 'w') as f:
        f.write(compose_hash)

    print("\n=== Files Generated ===")
    print("- app-compose.json: Human-readable app compose configuration")
    print("- app-compose-deterministic.json: Deterministic JSON used for hashing")
    print("- compose-hash.txt: The SHA256 hash")

    return compose_hash


if __name__ == "__main__":
    main()