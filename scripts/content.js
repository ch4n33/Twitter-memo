const idPosition = 'head > script:nth-child(49)';
const memoPosition = '#react-root > div > div > div.css-175oi2r.r-1f2l425.r-13qz1uu.r-417010.r-18u37iz > main > div > div > div > div > div > div:nth-child(3) > div > div > div > div > div.css-175oi2r.r-6gpygo.r-14gqq1x > div.css-175oi2r.r-1wbh5a2.r-dnmrzs.r-1ny4l3l > div > div.css-175oi2r.r-1awozwy.r-18u37iz.r-1wbh5a2 > div > div > div > span';
const observePosition = '#react-root > div > div > div.css-175oi2r.r-1f2l425.r-13qz1uu.r-417010.r-18u37iz > main > div > div > div > div > div > div:nth-child(3) > div > div > div > div > div.css-175oi2r.r-6gpygo.r-14gqq1x > div.css-175oi2r.r-1wbh5a2.r-dnmrzs.r-1ny4l3l > div';
function getId() {
    var a = document.querySelectorAll(idPosition)
    var b = Array.from(a)
    var c = b.map((x) => x.innerText);
    var data = c[0];

    try {
    return JSON.parse(data)['author'];
    } catch (e) {
        return 'not found';
    }
}
  
//regex_url = /^https:\/\/twitter\.com\/(?!home$).+/;
regex_twitter_handle = /^https:\/\/twitter\.com\/(?!home$)([a-zA-Z0-9_]{1,15})$/;

var id = 'not found';
const observer_initial = new MutationObserver(async (mutationList, observer) => {
    id = getId();
    if (id !== 'not found'){
        console.log('found id :' + id.identifier);
        observer.disconnect();
        await chrome.runtime.sendMessage({action: 'getMemo', id: id.identifier}, function(response) {
            memo = response.res;
            if (memo !== ''){
                var target_handle=Array.from(document.querySelectorAll(memoPosition))[0]
                var handle = window.location.href.match(regex_twitter_handle)[1];
                target_handle.textContent = '@' + handle + ' : \'' + memo + '\'';
            }
        });
    }
});

const el = document.getElementsByTagName('head');
window.addEventListener('popstate', function() {
    console.log('popstate changed');
    observer_initial.observe(el[0], {
        childList: true,
        subtree: true,
        attributeOldValue: true,
    });
});
observer_initial.observe(el[0], {
    childList: true,
    subtree: true,
    attributeOldValue: true,
});

const observeUrlChange = () => {
    let oldHref = document.location.href;
    const body = document.querySelector("body");
    const observer = new MutationObserver(mutations => {
        if (oldHref !== document.location.href) {
            oldHref = document.location.href;
            observer_initial.observe(el[0], {
                childList: true,
                subtree: true,
                attributeOldValue: true,
            });
        }
    });
    observer.observe(body, { childList: true, subtree: true });
};
window.onload = observeUrlChange;

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.action !== 'tmemo_requestData') {
            return;
        }
        console.log('content.js:action=' + request.action);
        if (id === 'not found') {
            sendResponse({'id': 'not found'})
        }
        else{
            sendResponse({'id': id.identifier});
        }
    }
)
