#!/usr/bin/env python3
"""
Python Security Service Subprocess
Runs inside tokscope-enclave container, communicates via stdin/stdout
"""

import sys
import json
import logging
import time
import secrets
from typing import Dict, Any
from urllib.parse import urlencode

# Add lib directory to path
sys.path.insert(0, '/app/security-service/lib')

# Import security modules
from XGorgon import XGorgon
from XArgus import Argus as XArgus
from XLadon import Ladon as XLadon
from TTEncrypt import TT as TTEncrypt

# Configure logging to stderr (stdout used for IPC)
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format='[Python] %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

class SecurityServiceSubprocess:
    def __init__(self):
        self.gorgon = XGorgon()
        self.argus = XArgus()
        self.ladon = XLadon()
        self.encrypt = TTEncrypt()
        logger.info("Security modules initialized")

    def generate_headers(self, params: str, cookies: str, stub: str, timestamp: int) -> Dict[str, str]:
        """Generate security headers"""
        try:
            # Build headers dict for XGorgon
            headers_dict = {'cookie': cookies} if cookies else {}

            # Generate X-Gorgon and X-Khronos
            gorgon_result = self.gorgon.get_value(
                params=params,
                data=None,
                stub=stub,
                headers_dict=headers_dict,
                timestamp=timestamp
            )

            # Generate X-Argus
            argus_value = self.argus.get_value(
                params=params,
                cookies=cookies,
                timestamp=timestamp
            )

            # Generate X-Ladon
            ladon_value = self.ladon.get_value(params)

            return {
                'X-Gorgon': gorgon_result.get('X-Gorgon', ''),
                'X-Khronos': str(gorgon_result.get('X-Khronos', timestamp)),
                'X-Argus': argus_value,
                'X-Ladon': ladon_value
            }
        except Exception as e:
            logger.error(f"Header generation failed: {e}")
            raise

    def build_authenticated_params(self, base_params: Dict[str, Any], session_data: Dict[str, Any]) -> Dict[str, Any]:
        """Build authenticated params with security headers"""
        try:
            timestamp = int(time.time())
            stub = secrets.token_hex(16)

            # Merge base params
            params = {**base_params}

            # Add device info from session
            if 'tokens' in session_data:
                tokens = session_data['tokens']
                if 'device_id' in tokens:
                    params['device_id'] = tokens['device_id']
                if 'install_id' in tokens:
                    params['iid'] = tokens['install_id']

            # Build query string
            params_string = urlencode(params)

            # Get cookies from session
            cookies = ''
            if 'cookies' in session_data and session_data['cookies']:
                if isinstance(session_data['cookies'], list):
                    cookies = '; '.join([f"{c['name']}={c['value']}" for c in session_data['cookies']])
                elif isinstance(session_data['cookies'], str):
                    cookies = session_data['cookies']

            # Generate security headers
            headers = self.generate_headers(params_string, cookies, stub, timestamp)

            # Add headers to params
            params.update(headers)

            return params

        except Exception as e:
            logger.error(f"buildAuthenticatedParams failed: {e}")
            raise

    def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Handle incoming request"""
        action = request.get('action')
        request_id = request.get('requestId')

        if action == 'getApiConfig':
            return {
                'success': True,
                'requestId': request_id,
                'config': {
                    'baseUrl': 'https://api16-normal-c-useast1a.tiktokv.com',
                    'userAgent': 'okhttp/3.12.13',
                    'endpoints': {
                        'feed': '/aweme/v1/feed/',
                        'recommended': '/aweme/v1/feed/'
                    }
                }
            }

        elif action == 'generateDeviceAuth':
            # Mobile API device authentication
            sec_user_id = request.get('secUserId', '')
            return {
                'success': True,
                'requestId': request_id,
                'deviceAuth': {
                    'sec_user_id': sec_user_id
                }
            }

        elif action == 'buildAuthenticatedParams':
            base_params = request.get('baseParams', {})
            session_data = request.get('sessionData', {})

            authenticated_params = self.build_authenticated_params(base_params, session_data)

            return {
                'success': True,
                'requestId': request_id,
                'params': authenticated_params
            }

        elif action == 'generateHeaders':
            params = request.get('params', '')
            cookies = request.get('cookies', '')
            stub = request.get('stub', secrets.token_hex(16))
            timestamp = request.get('timestamp', int(time.time()))

            headers = self.generate_headers(params, cookies, stub, timestamp)

            return {
                'success': True,
                'requestId': request_id,
                'headers': headers
            }

        else:
            return {
                'success': False,
                'requestId': request_id,
                'error': f'Unknown action: {action}'
            }

    def run(self):
        """Main loop - read from stdin, write to stdout"""
        logger.info("Security service subprocess started, waiting for requests...")

        while True:
            try:
                # Read line from stdin
                line = sys.stdin.readline()
                if not line:
                    break

                # Parse JSON request
                request = json.loads(line.strip())

                # Handle request
                response = self.handle_request(request)

                # Write JSON response to stdout
                print(json.dumps(response), flush=True)

            except json.JSONDecodeError as e:
                error_response = {
                    'success': False,
                    'error': f'Invalid JSON: {e}'
                }
                print(json.dumps(error_response), flush=True)

            except Exception as e:
                logger.error(f"Request handling error: {e}", exc_info=True)
                error_response = {
                    'success': False,
                    'error': str(e)
                }
                print(json.dumps(error_response), flush=True)

if __name__ == '__main__':
    service = SecurityServiceSubprocess()
    service.run()
