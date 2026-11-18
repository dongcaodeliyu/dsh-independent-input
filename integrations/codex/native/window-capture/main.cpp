#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <iostream>
#include <string>
#include <filesystem>
#include <chrono>
#include <thread>
#include <sstream>
using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
struct Failure { const char* reason; };
std::string utf8(std::wstring const& s) { return to_string(s); }
std::string quote(std::string const& s) { std::string r="\""; for(unsigned char c:s) { if(c=='"'||c=='\\') {r+='\\';r+=c;} else if(c<32) {char b[7]; sprintf_s(b,"\\u%04x",c);r+=b;} else r+=c; } return r+'"'; }
struct Geometry {RECT window{}, extended{}; bool hasExtended=false;};
Geometry geometry(HWND h) {Geometry g; if(!IsWindow(h)) throw Failure{"window_closed"}; if(IsIconic(h)) throw Failure{"window_minimized"}; if(!IsWindowVisible(h)) throw Failure{"window_hidden"}; DWORD affinity=0; if(GetWindowDisplayAffinity(h,&affinity)&&affinity!=WDA_NONE) throw Failure{"window_capture_protected"}; DWORD cloaked=0; if(SUCCEEDED(DwmGetWindowAttribute(h,DWMWA_CLOAKED,&cloaked,sizeof(cloaked)))&&cloaked) throw Failure{"window_cloaked"}; if(!GetWindowRect(h,&g.window)) throw Failure{"window_geometry_failed"}; g.hasExtended=SUCCEEDED(DwmGetWindowAttribute(h,DWMWA_EXTENDED_FRAME_BOUNDS,&g.extended,sizeof(RECT))); if(g.window.right<=g.window.left||g.window.bottom<=g.window.top) throw Failure{"window_empty"}; return g;}
bool equal(RECT a,RECT b){return EqualRect(&a,&b)!=FALSE;}
bool matches(RECT r,int w,int h){return r.right-r.left==w&&r.bottom-r.top==h;}
void savePng(std::wstring const& path, ID3D11Device* device, ID3D11DeviceContext* context, ID3D11Texture2D* texture,int width,int height) {
 D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc); if(width<=0||height<=0||UINT(width)>desc.Width||UINT(height)>desc.Height) throw Failure{"frame_size_invalid"};
 desc.Width=width;desc.Height=height;desc.MipLevels=1;desc.ArraySize=1;desc.SampleDesc={1,0};desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.MiscFlags=0;
 com_ptr<ID3D11Texture2D> staging;check_hresult(device->CreateTexture2D(&desc,nullptr,staging.put()));D3D11_BOX box{0,0,0,UINT(width),UINT(height),1};context->CopySubresourceRegion(staging.get(),0,0,0,0,texture,0,&box);
 D3D11_MAPPED_SUBRESOURCE mapped{};check_hresult(context->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped));
 try {com_ptr<IWICImagingFactory> factory;check_hresult(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(factory.put())));com_ptr<IWICStream> stream;check_hresult(factory->CreateStream(stream.put()));check_hresult(stream->InitializeFromFilename(path.c_str(),GENERIC_WRITE));com_ptr<IWICBitmapEncoder> encoder;check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,encoder.put()));check_hresult(encoder->Initialize(stream.get(),WICBitmapEncoderNoCache));com_ptr<IWICBitmapFrameEncode> frame;com_ptr<IPropertyBag2> props;check_hresult(encoder->CreateNewFrame(frame.put(),props.put()));check_hresult(frame->Initialize(props.get()));check_hresult(frame->SetSize(width,height)); WICPixelFormatGUID format=GUID_WICPixelFormat32bppBGRA;check_hresult(frame->SetPixelFormat(&format));if(format!=GUID_WICPixelFormat32bppBGRA) throw Failure{"png_format_unsupported"};check_hresult(frame->WritePixels(height,mapped.RowPitch,mapped.RowPitch*height,static_cast<BYTE*>(mapped.pData)));check_hresult(frame->Commit());check_hresult(encoder->Commit());}catch(...){context->Unmap(staging.get(),0);throw;} context->Unmap(staging.get(),0);
}
int wmain(int argc,wchar_t**argv) {try {
 init_apartment(apartment_type::multi_threaded);SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
 if(argc==2&&std::wstring(argv[1])==L"--probe") {
  bool supported=GraphicsCaptureSession::IsSupported();
  bool interopAvailable=false; try {auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();interopAvailable=bool(interop);}catch(hresult_error const&){}
  bool freeThreaded=winrt::Windows::Foundation::Metadata::ApiInformation::IsMethodPresent(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool",L"CreateFreeThreaded");
  OSVERSIONINFOW version{};version.dwOSVersionInfoSize=sizeof(version);auto rtl=reinterpret_cast<LONG(WINAPI*)(OSVERSIONINFOW*)>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlGetVersion"));bool gotVersion=rtl&&rtl(&version)==0;
  std::cout<<"{\"ok\":true,\"captureBackend\":\"wgc-window\",\"supported\":"<<(supported?"true":"false")<<",\"createForWindowAvailable\":"<<(interopAvailable?"true":"false")<<",\"createFreeThreadedAvailable\":"<<(freeThreaded?"true":"false")<<",\"osBuild\":";if(gotVersion)std::cout<<version.dwBuildNumber;else std::cout<<"null";std::cout<<",\"probeOnly\":true}\n";return 0;
 }
 uint64_t handle=0; std::wstring path;unsigned timeout=5000; bool gotHandle=false;
 for(int i=1;i<argc;i+=2){if(i+1>=argc) throw Failure{"invalid_arguments"};std::wstring key=argv[i], value=argv[i+1];size_t consumed=0;try {if(key==L"--hwnd"){if(value.empty()||value[0]==L'-') throw Failure{"invalid_arguments"};handle=std::stoull(value,&consumed,10);if(consumed!=value.size())throw Failure{"invalid_arguments"};gotHandle=true;}else if(key==L"--path")path=value;else if(key==L"--timeout-ms"){auto n=std::stoul(value,&consumed,10);if(consumed!=value.size()||n<1||n>60000)throw Failure{"invalid_arguments"};timeout=unsigned(n);}else throw Failure{"invalid_arguments"};}catch(std::exception const&){throw Failure{"invalid_arguments"};}}
 if(!gotHandle||path.empty()||!std::filesystem::path(path).is_absolute())throw Failure{"invalid_arguments"};HWND hwnd=reinterpret_cast<HWND>(uintptr_t(handle));auto before=geometry(hwnd);if(!GraphicsCaptureSession::IsSupported())throw Failure{"wgc_unsupported"};
 com_ptr<ID3D11Device> device;com_ptr<ID3D11DeviceContext> context;D3D_FEATURE_LEVEL level;check_hresult(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,device.put(),&level,context.put()));auto dxgi=device.as<IDXGIDevice>();com_ptr<IInspectable> inspectable;check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),inspectable.put()));auto direct=inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
 auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();GraphicsCaptureItem item{nullptr};check_hresult(interop->CreateForWindow(hwnd,guid_of<GraphicsCaptureItem>(),put_abi(item)));auto pool=Direct3D11CaptureFramePool::CreateFreeThreaded(direct,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,item.Size());auto session=pool.CreateCaptureSession(item); struct CloseCapture { GraphicsCaptureSession session; Direct3D11CaptureFramePool pool; ~CloseCapture(){try{session.Close();}catch(...){} try{pool.Close();}catch(...){}} } closeCapture{session,pool};session.StartCapture();Direct3D11CaptureFrame frame{nullptr};auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeout);
 while(std::chrono::steady_clock::now()<deadline){frame=pool.TryGetNextFrame();if(frame)break; if(!IsWindow(hwnd))throw Failure{"window_closed"};std::this_thread::sleep_for(std::chrono::milliseconds(10));}if(!frame)throw Failure{"capture_timeout"};auto size=frame.ContentSize();auto after=geometry(hwnd);if(!equal(before.window,after.window)||before.hasExtended!=after.hasExtended||(before.hasExtended&&!equal(before.extended,after.extended)))throw Failure{"window_geometry_changed_reobserve"};
 RECT rect{};const char* mapping="unverified";bool verified=false;if(after.hasExtended&&matches(after.extended,size.Width,size.Height)){rect=after.extended;mapping="dwm-extended-frame-bounds";verified=true;}else if(matches(after.window,size.Width,size.Height)){rect=after.window;mapping="window-rect";verified=true;}
 auto access=frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();com_ptr<ID3D11Texture2D> texture;check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()));auto temp=path+L".wgc-tmp-"+std::to_wstring(GetCurrentProcessId());try{savePng(temp,device.get(),context.get(),texture.get(),size.Width,size.Height);auto finalGeometry=geometry(hwnd);if(!equal(after.window,finalGeometry.window)||after.hasExtended!=finalGeometry.hasExtended||(after.hasExtended&&!equal(after.extended,finalGeometry.extended)))throw Failure{"window_geometry_changed_reobserve"};if(!MoveFileExW(temp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))check_hresult(HRESULT_FROM_WIN32(GetLastError()));}catch(...){DeleteFileW(temp.c_str());throw;}
 frame.Close();session.Close();pool.Close();std::cout<<"{\"ok\":true,\"path\":"<<quote(utf8(path))<<",\"sourceHwnd\":\""<<handle<<"\",\"captureBackend\":\"wgc-window\",\"width\":"<<size.Width<<",\"height\":"<<size.Height<<",\"occlusionSafe\":true,\"mappingVerified\":"<<(verified?"true":"false")<<",\"mappingSource\":"<<quote(mapping)<<",\"screenRect\":";if(verified)std::cout<<"{\"x\":"<<rect.left<<",\"y\":"<<rect.top<<",\"width\":"<<size.Width<<",\"height\":"<<size.Height<<"}";else std::cout<<"null";std::cout<<"}\n";return 0;
 }catch(Failure const& f){std::cout<<"{\"ok\":false,\"reason\":"<<quote(f.reason)<<"}\n";}catch(hresult_error const&e){std::ostringstream h;h<<"0x"<<std::hex<<uint32_t(e.code().value);std::cout<<"{\"ok\":false,\"reason\":\"capture_api_failed\",\"hresult\":"<<quote(h.str())<<"}\n";}catch(...){std::cout<<"{\"ok\":false,\"reason\":\"capture_failed\"}\n";}return 1;}
