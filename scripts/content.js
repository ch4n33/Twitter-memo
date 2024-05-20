const memoPosition = '#react-root > div > div > div.css-175oi2r.r-1f2l425.r-13qz1uu.r-417010.r-18u37iz > main > div > div > div > div > div > div:nth-child(3) > div > div > div > div > div.css-175oi2r.r-6gpygo.r-14gqq1x > div.css-175oi2r.r-1wbh5a2.r-dnmrzs.r-1ny4l3l > div > div.css-175oi2r.r-1awozwy.r-18u37iz.r-1wbh5a2 > div > div > div > span';
const observePosition = '#react-root > div > div > div.css-175oi2r.r-1f2l425.r-13qz1uu.r-417010.r-18u37iz > main > div > div > div > div > div > div:nth-child(3) > div > div > div > div > div.css-175oi2r.r-6gpygo.r-14gqq1x > div.css-175oi2r.r-1wbh5a2.r-dnmrzs.r-1ny4l3l > div';
function getId() {
    var a = document.querySelectorAll('script[type="application/ld+json"]')
    var b = Array.from(a)
    var c = b.map((x) => x.innerText);
    var data = c[0];
    try {
    return JSON.parse(data)['author'];
    } catch (e) {
        return 'not found';
    }
}

const regex_twitter_handle = /^https:\/\/twitter\.com\/(?!home$)((intent\/user\?screen_name=([a-zA-Z0-9_]{1,15})$)|(([a-zA-Z0-9_]{1,15})(?:\/(?:with_replies|highlights|articles|media|likes))?(?:\?.*)?$))/;

var id = 'not found';
const observer_initial = new MutationObserver(async (mutationList, observer) => {
    id = getId();
    if (id !== 'not found'){
        // console.log('found id :' + id.identifier);
        observer.disconnect();
        var handle = id.additionalName;
        console.log('handle: ' + handle);
        await chrome.runtime.sendMessage({action: 'getMemo', id: id.identifier}, function(response) {
            memo = response.res;
            var target_handle=Array.from(document.querySelectorAll(memoPosition))[0];
            if (memo){
                if (window.location.href.includes("twitter.com/home") 
                    || window.location.href.includes("x.com/home")) return;
                console.log('changetarget: ' + '@' + handle + ' : \'' + memo + '\'');
                target_handle.textContent = '@' + handle + ' : \'' + memo + '\'';
            }else{
                console.log('not changed target: ' + '@' + handle);
                target_handle.textContent = '@' + handle;
            }
        });
    }else if (!regex_twitter_handle.test(window.location.href)){
        observer.disconnect();
    }
});

const el = document.head;


const observeUrlChange = () => {
    let oldHref = document.location.href;
    const body = document.body;
    const observer = new MutationObserver(mutations => {
        if (oldHref !== document.location.href) {
            // console.log('url changed');
            oldHref = document.location.href;
            observer_initial.observe(el, {
                childList: true,
                subtree: true,
                attributeOldValue: true,
            });
        }
    });
    observer.observe(body, { childList: true, subtree: true });
};
window.onload = observeUrlChange;
observer_initial.observe(el, {
    childList: true,
    subtree: true,
    attributeOldValue: true,
});

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.action !== 'tmemo_requestData') {
            return;
        }
        console.log('content.js:action=' + request.action);
        if (id === 'not found') {
            console.log('id not found in requestData');
            sendResponse({'id': 'not found'})
        }
        else{
            sendResponse({'id': id.identifier});
        }
    }
)
