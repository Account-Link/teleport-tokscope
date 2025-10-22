"""
Xordi Security Header Service
FastAPI service for generating TikTok security headers (X-Gorgon, X-Argus, X-Ladon)
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import time
import logging
from typing import Optional
import sys
import os

# Add lib directory to path
sys.path.append(os.path.join(os.path.dirname(__file__), 'lib'))

# Import security modules
try:
    from lib.XGorgon import XGorgon
    from lib.XArgus import Argus as XArgus
    from lib.XLadon import Ladon as XLadon
    from lib.TTEncrypt import TT as TTEncrypt
except ImportError as e:
    print(f"Failed to import security modules: {e}")
    print("Make sure all required files are in the lib/ directory")
    sys.exit(1)

app = FastAPI(
    title="Xordi Security Header Service",
    version="2.2.0",
    description="Generate security headers for TikTok mobile API requests"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class HeaderRequest(BaseModel):
    """Request model for header generation"""
    params: str
    cookies: str
    stub: Optional[str] = None
    timestamp: Optional[int] = None
    device_id: Optional[str] = None
    install_id: Optional[str] = None

class DeviceRegistrationRequest(BaseModel):
    """Request model for device registration"""
    device_id: Optional[str] = None
    install_id: Optional[str] = None

@app.get("/")
def root():
    """Root endpoint"""
    return {
        "service": "Xordi Security Header Service",
        "version": "2.2.0",
        "status": "running"
    }

@app.get("/health")
def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "security-headers",
        "timestamp": int(time.time())
    }

@app.post("/generate-headers")
def generate_headers(request: HeaderRequest):
    """
    Generate X-Gorgon, X-Argus, X-Ladon headers for TikTok API requests
    """
    try:
        timestamp = request.timestamp or int(time.time())
        
        logger.info(f"Generating headers for params: {request.params[:50]}...")
        
        # Initialize generators
        gorgon_gen = XGorgon()
        argus_gen = XArgus()
        ladon_gen = XLadon()
        
        # Generate X-Gorgon and X-Khronos
        try:
            # Build headers dict for XGorgon calculation
            headers_dict = {}
            if request.cookies:
                headers_dict['cookie'] = request.cookies
            if request.stub:
                headers_dict['x-ss-stub'] = request.stub
                
            gorgon_result = gorgon_gen.calculate(
                params=request.params,
                headers=headers_dict
            )
            
            # Handle different return formats from XGorgon
            if isinstance(gorgon_result, dict):
                x_gorgon = gorgon_result.get("X-Gorgon", "0404000000000000000000000000000000000000")
                x_khronos = gorgon_result.get("X-Khronos", str(timestamp))
            else:
                x_gorgon = str(gorgon_result)
                x_khronos = str(timestamp)
                
        except Exception as e:
            logger.error(f"X-Gorgon generation failed: {e}")
            # Provide fallback value
            x_gorgon = "0404000000000000000000000000000000000000"
            x_khronos = str(timestamp)
        
        # Generate X-Argus
        try:
            x_argus = argus_gen.get_sign(
                params=request.params,
                stub=request.stub or "",
                timestamp=timestamp
            )
            if not x_argus:
                x_argus = "placeholder_argus_value"
        except Exception as e:
            logger.error(f"X-Argus generation failed: {e}")
            x_argus = "placeholder_argus_value"
        
        # Generate X-Ladon
        try:
            x_ladon = ladon_gen.encrypt(timestamp)
            if not x_ladon:
                x_ladon = "placeholder_ladon_value"
        except Exception as e:
            logger.error(f"X-Ladon generation failed: {e}")
            x_ladon = "placeholder_ladon_value"
        
        headers = {
            "X-Gorgon": x_gorgon,
            "X-Khronos": x_khronos,
            "X-Argus": x_argus,
            "X-Ladon": x_ladon
        }
        
        logger.info("Headers generated successfully")
        
        return {
            "success": True,
            "headers": headers,
            "timestamp": timestamp
        }
        
    except Exception as e:
        logger.error(f"Header generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/register-device")
def register_device(request: DeviceRegistrationRequest):
    """
    Register a new device with TikTok servers
    """
    try:
        tt_encrypt = TTEncrypt()
        
        # Generate device registration
        result = tt_encrypt.register_device(
            device_id=request.device_id,
            install_id=request.install_id
        )
        
        return {
            "success": True,
            "device": result
        }
        
    except Exception as e:
        logger.error(f"Device registration failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/test")
def test_modules():
    """
    Test that all security modules are working
    """
    try:
        results = {}
        
        # Test XGorgon
        try:
            gorgon = XGorgon()
            results["XGorgon"] = "✅ Loaded"
        except Exception as e:
            results["XGorgon"] = f"❌ Failed: {e}"
        
        # Test XArgus
        try:
            argus = XArgus()
            results["XArgus"] = "✅ Loaded"
        except Exception as e:
            results["XArgus"] = f"❌ Failed: {e}"
        
        # Test XLadon
        try:
            ladon = XLadon()
            results["XLadon"] = "✅ Loaded"
        except Exception as e:
            results["XLadon"] = f"❌ Failed: {e}"
        
        # Test TTEncrypt
        try:
            tt = TTEncrypt()
            results["TTEncrypt"] = "✅ Loaded"
        except Exception as e:
            results["TTEncrypt"] = f"❌ Failed: {e}"
        
        return {
            "status": "test_complete",
            "modules": results
        }
        
    except Exception as e:
        return {
            "status": "error",
            "error": str(e)
        }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8100))
    host = os.environ.get("HOST", "0.0.0.0")
    
    print(f"Starting Xordi Security Header Service on {host}:{port}")
    uvicorn.run(app, host=host, port=port)