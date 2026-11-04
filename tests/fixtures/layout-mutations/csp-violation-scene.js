// a violation that fires only after a scene is opened (the sweep sets location.hash to the scene): the wall is clean, so collecting before the scenes are opened would never see it
addEventListener("hashchange", () => { if (location.hash === "#five") { const i = new Image(); i.src = "https://csp-mutation.invalid/scene.png"; } });
